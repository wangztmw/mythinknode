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
        const s = new Session(data.id, data.startedAt);
        s.messages = (data.messages as ChatMessage[]).filter(m => !(m.role === 'assistant' && Array.isArray(m.content) && m.content.length === 0));
        s.toolCount = data.toolCount || 0;
        s.cumulativeTokens = data.cumulativeTokens || 0;
        s.tokenMarkers = Array.isArray(data.tokenMarkers) ? data.tokenMarkers : [];
        s.pendingNotifications = Array.isArray(data.pendingNotifications) ? data.pendingNotifications : [];
        s.keywordIndex = loadKeywords(data.id);
        s.firstUserMessage = typeof data.firstUserMessage === 'string' ? data.firstUserMessage : s.messages.find(isUserIntent)?.content;
        s.baseName = typeof data.baseName === 'string' ? data.baseName : undefined;
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
      const s = new Session(data.id, data.startedAt);
      s.messages = (data.messages as ChatMessage[]).filter(m => !(m.role === 'assistant' && Array.isArray(m.content) && m.content.length === 0));
      s.toolCount = data.toolCount || 0;
      s.cumulativeTokens = data.cumulativeTokens || 0;
      s.tokenMarkers = Array.isArray(data.tokenMarkers) ? data.tokenMarkers : [];
      s.pendingNotifications = Array.isArray(data.pendingNotifications) ? data.pendingNotifications : [];
      s.keywordIndex = loadKeywords(data.id);
      s.firstUserMessage = typeof data.firstUserMessage === 'string' ? data.firstUserMessage : s.messages.find(isUserIntent)?.content;
      s.baseName = typeof data.baseName === 'string' ? data.baseName : undefined;
      return s;
    } catch { return null; }
  }

  /** 显示会话选择器并返回用户选择的会话，或 null 表示开新会话 */
  static async pickSession(): Promise<Session | null> {
    let lastSession: Session | null = null;
    if (Session.hasUnfinished()) {
      lastSession = Session.load();
      if (lastSession) lastSession.unlock();
    }

    const all = Session.listAll();
    if (all.length === 0) return null;

    console.log(`Available sessions (${all.length}):\n`);
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      const marker = lastSession && s.id === lastSession.id ? ' ← last' : '';
      console.log(`  ${i + 1}. ${s.id} — ${s.messages} messages, ${s.toolCount} tools${marker}`);
    }
    console.log(`\nEnter number to resume, or press Enter to start new session.`);

    return new Promise(resolve => {
      process.stdin.once('data', d => {
        const idx = parseInt(d.toString().trim()) - 1;
        if (idx >= 0 && idx < all.length) {
          resolve(Session.loadById(all[idx].id));
        } else {
          resolve(null);
        }
      });
    });
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
    const oldDir = sessionDir(this.id);
    if (!existsSync(oldDir)) {
      this.id = target;
      return;
    }
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      renameSync(oldDir, sessionDir(target));
      this.id = target;
    } catch { /* 重命名失败：保留原 id，下次再试 */ }
  }

  /**
   * 会话命名：
   *   {创建时间}-{第一句话意图}[-{最近5条输入的意图概括}]
   * 基础名只生成一次并持久化；每次完成时重算尾缀并整体替换，不累积。
   */
  async summarize(llm: { chat: (msgs: ChatMessage[], prompt?: string) => Promise<{ content: unknown[]; stop_reason: string }> }): Promise<void> {
    try {
      if (!this.baseName) {
        const first = this.firstUserMessage ?? this.messages.find(isUserIntent)?.content;
        if (!first) return; // 没有用户输入（如恢复的空会话），保持原 id
        const intent = await this.extractIntent(llm, [first], BASE_INTENT_PROMPT, 12);
        if (!intent) return;
        this.baseName = `${timePrefix(this.startedAt)}-${intent}`;
      }

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
    }, null, 2));
    // 关键词索引独立存盘（session.json 字段不动）
    saveKeywords(this.id, this.keywordIndex);
  }
}
