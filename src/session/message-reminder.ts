/**
 * MessageReminder — 记忆召回。根据用户输入，从关键词索引里召回相关历史块，
 * 按时间顺序返回原文消息，供本轮 query_loop 作为背景上下文（不污染 session.messages）。
 */
import type { ChatMessage, LLMResponse } from '../llm/types.js';
import { loadRaw } from './session_raw.js';
import { buildReminderPrompt } from './message-reminder_prompt.js';

export interface RecallResult {
  tags: string[];                          // 命中的块 tag，按 S{n} 序号升序（=时间序）
  blocks: Record<string, ChatMessage[]>;   // tag -> 原文消息（loadRaw 取回）
}

export type KeywordIndex = Record<string, string[]>;  // tag -> keywords[]

function tagOrder(tag: string): number {
  return parseInt(tag.replace(/^S/, ''), 10) || 0;
}

function extractText(response: { content: unknown[] }): string {
  return (response.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
}

/** 从 LLM 输出里解析选中关键词，只接受候选集里存在的（防 LLM 瞎编） */
function parseSelected(text: string, candidates: string[]): string[] {
  const m = text.match(/\[[\s\S]*?\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        return arr.filter((k): k is string => typeof k === 'string' && candidates.includes(k));
      }
    } catch { /* fall through to comma split */ }
  }
  // 退化为逗号/顿号/换行分隔
  return text.split(/[,，、\n]/)
    .map(s => s.trim().replace(/["\[\]]/g, ''))
    .filter(k => candidates.includes(k));
}

export class MessageReminder {
  private llm: { chat: (msgs: ChatMessage[], prompt?: string) => Promise<LLMResponse> };

  constructor(llm: { chat: (msgs: ChatMessage[], prompt?: string) => Promise<LLMResponse> }) {
    this.llm = llm;
  }

  async recall(userInput: string, index: KeywordIndex, sessionId: string): Promise<RecallResult> {
    const empty: RecallResult = { tags: [], blocks: {} };
    const tags = Object.keys(index);
    if (tags.length === 0) return empty;

    // 1. 候选关键词（去重）
    const candidates = [...new Set(tags.flatMap(t => index[t]))];
    if (candidates.length === 0) return empty;

    // 2. LLM 从候选集里选
    let selected: string[] = [];
    try {
      const prompt = buildReminderPrompt(userInput, candidates);
      const r = await this.llm.chat([{ role: 'user', content: prompt }]);
      selected = parseSelected(extractText(r), candidates);
    } catch { return empty; }

    if (selected.length === 0) return empty;

    // 3. 反查：含选中关键词的 tag
    const hit = new Set<string>();
    for (const [tag, kws] of Object.entries(index)) {
      if (kws.some(k => selected.includes(k))) hit.add(tag);
    }

    // 4. 按时间序（S 序号升序）
    const ordered = [...hit].sort((a, b) => tagOrder(a) - tagOrder(b));

    // 5. loadRaw 取原文
    const blocks: Record<string, ChatMessage[]> = {};
    for (const tag of ordered) {
      const msgs = loadRaw(sessionId, tag) as ChatMessage[];
      if (msgs.length > 0) blocks[tag] = msgs;
    }

    return { tags: ordered, blocks };
  }
}
