/**
 * Session — 会话持久化。消息数组 + 通知队列 + 磁盘读写。
 *
 * 每次 agent 对话完成时自动保存。启动时检测未完成会话可恢复。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ChatMessage } from '../llm/types.js';
import { loadKeywords, saveKeywords } from './session_raw.js';
import { pickSessionFrom, parseStartedAtFromId } from './session_picker.js';

const SESSIONS_DIR = join(homedir(), '.mythinknode', 'sessions');
const sessionDir = (id: string) => join(SESSIONS_DIR, id);
const sessionPath = (id: string) => join(sessionDir(id), 'session.json');
const LOCK_FILE = join(SESSIONS_DIR, '.lock');

const BASE_INTENT_PROMPT =
  '以上是用户这轮会话的第一句话。用不超过12个中文字提炼用户的核心意图，不要标点，只输出短语。';
const SUFFIX_INTENT_PROMPT =
  '以上是用户最近的5条输入。用不超过20个中文字概括这些输入的意图（可按时间顺序合并），不要标点，只输出短语。';

/** 会话创建时间 → 目录名前缀 YYYYMMDD-HHMM（固定，重命名时不变） */
function timePrefix(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    + `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 清洗 LLM 输出为可做目录名的短语 */
function sanitizeTitle(text: string, maxLen: number): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^一-鿿\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
}

/**
 * 本地即时命名素材 —— 零 LLM 调用。
 *
 * 取第一行非空文本清洗成短语；英文按 `-` 词边界切，避免截出半个单词。
 * 中文没有空格，sanitizeTitle 后是整段，直接按长度截断。
 */
function localIntent(text: string, maxLen: number): string {
  const firstLine = text
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0) ?? '';
  if (!firstLine) return '';

  const cleaned = sanitizeTitle(firstLine, maxLen * 4);
  if (!cleaned) return '';
  if (cleaned.length <= maxLen) return cleaned;

  // 按 - 逐词累积，尽量不在词中间切；一个词就超长（无空格中文）时退回硬截断
  let out = '';
  for (const part of cleaned.split('-')) {
    const next = out ? `${out}-${part}` : part;
    if (next.length > maxLen) break;
    out = next;
  }
  return out || cleaned.slice(0, maxLen);
}

/**
 * 判断一条消息是否是用户真实输入。
 * 注入的检索结果/通知都以 "[" 开头（[S1] / [NODE MIND] / [TRAIT GRAPH] / [Agent ...]），
 * 不能当作意图素材。
 */
function isUserIntent(m: ChatMessage): m is ChatMessage & { content: string } {
  if (m.role !== 'user' || typeof m.content !== 'string') return false;
  const text = m.content.trim();
  return text.length > 0 && !text.startsWith('[');
}

export class Session {
  id: string;
  startedAt: number;
  messages: ChatMessage[] = [];
  toolCount = 0;
  cumulativeTokens = 0;
  tokenMarkers: number[] = [];
  pendingNotifications: Array<{ role: string; content: string }> = [];
  keywordIndex: Record<string, string[]> = {};
  /** 用户的第一句输入（压缩可能吞掉原消息，单独留一份） */
  firstUserMessage?: string;
  /** 会话基础名（时间前缀 + 第一句话意图），尾缀每次 summarize 时替换 */
  baseName?: string;
  /**
   * 基础名来源：
   *   provisional —— 首条消息到达时本地即时生成（零 LLM 调用），可能待精修
   *   llm         —— LLM 提炼过，视为终态，不再改名
   */
  baseNameSource?: 'provisional' | 'llm';

  constructor(id: string, startedAt?: number) {
    this.id = id;
    this.startedAt = startedAt ?? Date.now();
  }

  /** 添加消息到对话历史 */
  addMessage(msg: ChatMessage): void {
    this.messages.push(msg);
  }

  /** 注入通知到 pending 队列 */
  addNotification(msg: string): void {
    this.pendingNotifications.push({ role: 'user', content: msg });
  }

  /** flush 积压通知到 messages */
  flushNotifications(): void {
    while (this.pendingNotifications.length > 0) {
      this.messages.push(this.pendingNotifications.shift()! as ChatMessage);
    }
  }

  /** 标记会话开始（创建锁文件） */
  lock(): void {
    if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify({ id: this.id, startedAt: this.startedAt }));
  }

  /** 解除会话锁 */
  unlock(): void {
    try { unlinkSync(LOCK_FILE); } catch { /* 无所谓 */ }
  }

  /** 检查是否有未完成的上次会话 */
  static hasUnfinished(): boolean {
    try {
      if (!existsSync(LOCK_FILE)) return false;
      const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
      return existsSync(sessionPath(lock.id));
    } catch { return false; }
  }

  /** 从磁盘恢复上次未完成会话 */
  static load(): Session | null {
    try {
      const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
      const path = sessionPath(lock.id);
      if (existsSync(path)) {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        // 以目录名（== lock.id）为准，而不是 data.id：路径都是从目录名推出来的，
        // 历史文件里的 id 字段可能因为改名/旧版本而滞后。
        const s = new Session(lock.id, data.startedAt);
        s.messages = (data.messages as ChatMessage[]).filter(m => !(m.role === 'assistant' && Array.isArray(m.content) && m.content.length === 0));
        s.toolCount = data.toolCount || 0;
        s.cumulativeTokens = data.cumulativeTokens || 0;
        s.tokenMarkers = Array.isArray(data.tokenMarkers) ? data.tokenMarkers : [];
        s.pendingNotifications = Array.isArray(data.pendingNotifications) ? data.pendingNotifications : [];
        s.keywordIndex = loadKeywords(data.id);
        s.firstUserMessage = typeof data.firstUserMessage === 'string' ? data.firstUserMessage : s.messages.find(isUserIntent)?.content;
        s.baseName = typeof data.baseName === 'string' ? data.baseName : undefined;
        // 老会话没有 baseNameSource 字段：已有 baseName 的一定是旧 summarize 用 LLM 生成的 → 视为终态
        s.baseNameSource = data.baseNameSource === 'provisional'
          ? 'provisional'
          : (typeof s.baseName === 'string' ? 'llm' : undefined);
        return s;
      }
      return null;
    } catch { return null; }
  }

  /** 列出所有可恢复的会话 */
  static listAll(): Array<{ id: string; messages: number; toolCount: number }> {
    try {
      if (!existsSync(SESSIONS_DIR)) return [];
      const dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      const sessions: Array<{ id: string; messages: number; toolCount: number }> = [];
      for (const id of dirs) {
        const path = sessionPath(id);
        if (existsSync(path)) {
          try {
            const data = JSON.parse(readFileSync(path, 'utf-8'));
            sessions.push({ id, messages: data.messages?.length || 0, toolCount: data.toolCount || 0 });
          } catch { /* skip corrupted */ }
        }
      }
      return sessions.sort((a, b) => b.id.localeCompare(a.id));
    } catch { return []; }
  }

  /** 按 ID 加载指定会话 */
  static loadById(id: string): Session | null {
    try {
      const path = sessionPath(id);
      if (!existsSync(path)) return null;
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      // 同理：目录名是权威 id（loadById 的入参就是目录名）
      const s = new Session(id, data.startedAt);
      s.messages = (data.messages as ChatMessage[]).filter(m => !(m.role === 'assistant' && Array.isArray(m.content) && m.content.length === 0));
      s.toolCount = data.toolCount || 0;
      s.cumulativeTokens = data.cumulativeTokens || 0;
      s.tokenMarkers = Array.isArray(data.tokenMarkers) ? data.tokenMarkers : [];
      s.pendingNotifications = Array.isArray(data.pendingNotifications) ? data.pendingNotifications : [];
      s.keywordIndex = loadKeywords(data.id);
      s.firstUserMessage = typeof data.firstUserMessage === 'string' ? data.firstUserMessage : s.messages.find(isUserIntent)?.content;
      s.baseName = typeof data.baseName === 'string' ? data.baseName : undefined;
      // 老会话没有 baseNameSource 字段：已有 baseName 的一定是旧 summarize 用 LLM 生成的 → 视为终态
      s.baseNameSource = data.baseNameSource === 'provisional'
        ? 'provisional'
        : (typeof s.baseName === 'string' ? 'llm' : undefined);
      return s;
    } catch { return null; }
  }

  /**
   * 显示会话选择器。
   *
   * 返回三种结局：
   *   Session     —— 用户选中并加载成功
   *   null        —— 开新会话（空回车 / Ctrl+D / 重问耗尽）
   *   'abort'     —— 用户按 Ctrl+C（调用方应干净退出，而不是开新会话）
   *
   * 旧实现返回 `Session | null`，把 Ctrl+C 的 `parseInt('\x03') === NaN`
   * 也归到「开新会话」分支 —— 用户想退出却静默开了个新会话。
   *
   * 输入读取/解析/排版都在 session_picker.ts（纯逻辑、可单测）。
   */
  static async pickSession(): Promise<Session | null | 'abort'> {
    let lastSession: Session | null = null;
    if (Session.hasUnfinished()) {
      lastSession = Session.load();
      if (lastSession) lastSession.unlock();
    }

    const rows = Session.listAll().map(s => ({
      id: s.id,
      messages: s.messages,
      toolCount: s.toolCount,
      startedAt: Session.startedAtOf(s.id),
    }));
    if (rows.length === 0) return null;

    // cooked 模式下 Ctrl+C 不会变成 data 里的 \x03，而是发 SIGINT。
    // 此时 Mythinknode.ts 的信号处理器还没注册（它要等 cli 建好），
    // 所以这里临时挂一个只做「还原终端 + 退出」的处理器，选完移除。
    const onSigint = (): void => {
      try { process.stdin.setRawMode?.(false); } catch { /* 忽略 */ }
      process.stdout.write('\n');
      process.exit(0);
    };
    process.on('SIGINT', onSigint);
    try {
      const outcome = await pickSessionFrom(
        { stdin: process.stdin, stdout: process.stdout },
        rows,
        lastSession?.id ?? null,
      );
      if (outcome.kind === 'abort') return 'abort';
      if (outcome.kind === 'new') return null;
      return Session.loadById(outcome.id);
    } finally {
      process.off('SIGINT', onSigint);
    }
  }

  /** 读会话的开始时间（供选择器显示相对时间）；缺失时从目录名前缀兜底 */
  static startedAtOf(id: string): number | undefined {
    try {
      const path = sessionPath(id);
      if (existsSync(path)) {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        if (typeof data.startedAt === 'number' && Number.isFinite(data.startedAt)) return data.startedAt;
      }
    } catch { /* 落到目录名解析 */ }
    return parseStartedAtFromId(id);
  }

  /** 调用 LLM 提炼一句话意图（失败返回空串） */
  private async extractIntent(
    llm: { chat: (msgs: ChatMessage[], prompt?: string) => Promise<{ content: unknown[]; stop_reason: string }> },
    materials: string[],
    prompt: string,
    maxLen: number,
  ): Promise<string> {
    const messages: ChatMessage[] = materials.map(content => ({ role: 'user', content }));
    messages.push({ role: 'user', content: prompt });
    const r = await llm.chat(messages);
    const text = (r.content as Array<{ type: string; text?: string }>)
      .filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
    return sanitizeTitle(text, maxLen);
  }

  /** 重命名会话目录；目标已存在时追加 -2/-3 避免覆盖 */
  private renameTo(name: string): void {
    if (!name || name === this.id) return;
    let target = name;
    for (let n = 2; existsSync(sessionDir(target)) && target !== this.id; n++) {
      target = `${name}-${n}`;
    }
    const prevId = this.id;
    const oldDir = sessionDir(prevId);
    if (!existsSync(oldDir)) {
      this.id = target;
      this.syncLock(prevId);
      return;
    }
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      renameSync(oldDir, sessionDir(target));
      this.id = target;
      this.syncLock(prevId);
      // 目录名变了，session.json 里的 id 字段也要跟着改。
      // 否则下次 load() 拿到旧 id，会去按旧目录名找路径 —— 找不到会返回 null，
      // 找到（或重建）则产生一个 id 与目录名不一致的重复会话。
      this.rewritePersistedId();
    } catch { /* 重命名失败：保留原 id，下次再试 */ }
  }

  /** 把 session.json 里的 id 同步为当前 this.id（文件不存在则跳过） */
  private rewritePersistedId(): void {
    try {
      const path = sessionPath(this.id);
      if (!existsSync(path)) return;
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      if (data?.id === this.id) return;
      writeFileSync(path, JSON.stringify({ ...data, id: this.id }, null, 2));
    } catch { /* id 重写失败不影响主流程，load 侧也有兜底 */ }
  }

  /**
   * 锁文件里记的是会话 id。目录改名后必须同步，否则 `hasUnfinished()` / `load()`
   * 按旧 id 找目录会落空 —— 表现就是「上次没退干净的会话不被识别」。
   * 只在锁确实属于本会话（id === prevId）时才改写，避免动到别人的锁。
   */
  private syncLock(prevId: string): void {
    try {
      if (!existsSync(LOCK_FILE)) return;
      const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
      if (lock?.id !== prevId) return;
      writeFileSync(LOCK_FILE, JSON.stringify({ ...lock, id: this.id }));
    } catch { /* 锁同步失败不影响主流程 */ }
  }

  /**
   * 即时命名（零 LLM 调用）：首条用户消息一到就调用，让会话目录立刻可读。
   * 已有名字时不做任何事。返回是否发生了重命名。
   *
   * 为什么不等退出再命名：退出命名依赖一次 LLM 调用 + 一次目录 rename，
   * 任何一步失败（离线、本地服务已停、终端被 kill）会话就永远停在时间戳名字上。
   *
   * @param text 首条用户输入。主循环在 runSession 之前调用，此时 messages 还是空的，
   *             必须显式传入，不能只依赖 firstUserMessage。
   */
  provisionalBaseName(text?: string): boolean {
    if (this.baseName) return false;
    const first = text ?? this.firstUserMessage ?? this.messages.find(isUserIntent)?.content;
    if (!first) return false;
    const intent = localIntent(first, 12);
    if (!intent) return false;
    this.firstUserMessage ??= first;
    this.baseName = `${timePrefix(this.startedAt)}-${intent}`;
    this.baseNameSource = 'provisional';
    this.renameTo(this.baseName);
    return true;
  }

  /**
   * LLM 精修基础名：把 provisional 名字升级成 LLM 提炼的版本。
   * 已是 llm 终态时直接返回；失败保留现有名字（绝不回退成时间戳 id）。
   */
  async ensureBaseName(
    llm: { chat: (msgs: ChatMessage[], prompt?: string) => Promise<{ content: unknown[]; stop_reason: string }> },
  ): Promise<void> {
    if (this.baseNameSource === 'llm') return;
    const first = this.firstUserMessage ?? this.messages.find(isUserIntent)?.content;
    if (!first) return;
    try {
      const intent = await this.extractIntent(llm, [first], BASE_INTENT_PROMPT, 12);
      if (!intent) return;
      this.baseName = `${timePrefix(this.startedAt)}-${intent}`;
      this.baseNameSource = 'llm';
      this.renameTo(this.baseName);
    } catch { /* 保留现有名字 */ }
  }

  /**
   * 会话命名：
   *   {创建时间}-{第一句话意图}[-{最近5条输入的意图概括}]
   * 基础名只生成一次并持久化；每次完成时重算尾缀并整体替换，不累积。
   */
  async summarize(llm: { chat: (msgs: ChatMessage[], prompt?: string) => Promise<{ content: unknown[]; stop_reason: string }> }): Promise<void> {
    try {
      await this.ensureBaseName(llm);
      if (!this.baseName) return; // 没有用户输入（如恢复的空会话），保持原 id

      // 最近 5 条真实用户输入（从后往前取，保持时间顺序）
      const recent: string[] = [];
      for (let i = this.messages.length - 1; i >= 0 && recent.length < 5; i--) {
        const m = this.messages[i];
        if (isUserIntent(m)) recent.unshift(m.content);
      }

      const suffix = recent.length > 0
        ? await this.extractIntent(llm, recent, SUFFIX_INTENT_PROMPT, 20)
        : '';
      this.renameTo(suffix ? `${this.baseName}-${suffix}` : this.baseName);
    } catch { /* 失败保留原 id */ }
  }

  /** 保存当前会话到磁盘 */
  save(): void {
    if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(sessionDir(this.id), { recursive: true });
    writeFileSync(sessionPath(this.id), JSON.stringify({
      id: this.id,
      startedAt: this.startedAt,
      messages: this.messages,
      toolCount: this.toolCount,
      cumulativeTokens: this.cumulativeTokens,
      tokenMarkers: this.tokenMarkers,
      pendingNotifications: this.pendingNotifications,
      firstUserMessage: this.firstUserMessage,
      baseName: this.baseName,
      baseNameSource: this.baseNameSource,
    }, null, 2));
    // 关键词索引独立存盘（session.json 字段不动）
    saveKeywords(this.id, this.keywordIndex);
  }
}
