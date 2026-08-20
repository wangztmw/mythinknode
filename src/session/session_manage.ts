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

export class Session {
  id: string;
  startedAt: number;
  messages: ChatMessage[] = [];
  toolCount = 0;
  cumulativeTokens = 0;
  tokenMarkers: number[] = [];
  pendingNotifications: Array<{ role: string; content: string }> = [];
  keywordIndex: Record<string, string[]> = {};

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

  /** 调用 LLM 生成会话标题 */
  /** 调用 LLM 生成会话标题并重命名磁盘目录 */
  async summarize(llm: { chat: (msgs: ChatMessage[], prompt?: string) => Promise<{ content: unknown[]; stop_reason: string }> }): Promise<void> {
    try {
      // 只传 user 消息作为摘要素材（过滤掉工具噪音）
      const userMsgs = this.messages.filter(m => m.role === 'user').slice(-30);
      userMsgs.push({ role: 'user', content: '以上对话按时间顺序涉及了哪些主题？每个主题用3-5个中文字概括，用"/"分隔。覆盖全部内容，不要遗漏。只输出结果。' });
      const r = await llm.chat(userMsgs);
      const text = (r.content as Array<{ type: string; text?: string }>)
        .filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
      const topic = text.replace(/[^一-鿿\w\s-]/g, '').slice(0, 60).trim();
      // 用当前时间戳（不是原始创建时间）
      const now = new Date();
      const prefix = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
      const name = topic ? `${prefix}-${topic}` : this.id;
      if (name !== this.id) {
        const oldDir = sessionDir(this.id);
        const newDir = sessionDir(name);
        if (existsSync(oldDir)) {
          try { mkdirSync(SESSIONS_DIR, { recursive: true }); renameSync(oldDir, newDir); } catch {}
        }
        this.id = name;
      }
    } catch { /* 失败保留时间戳 */ }
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
    }, null, 2));
    // 关键词索引独立存盘（session.json 字段不动）
    saveKeywords(this.id, this.keywordIndex);
  }
}
