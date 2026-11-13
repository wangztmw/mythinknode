/**
 * 会话历史 → 可渲染块。
 *
 * 恢复会话时，光把 messages 塞回 LLM 上下文是不够的 —— 用户需要一个可见的
 * 「这就是我们上次聊到的地方」。这里把历史消息重放成终端可见的对话块。
 *
 * 刻意做成纯函数（不碰终端、不碰 store）：
 *   1. TUI（Ink store）和 classic（writeLines）共用同一份重放规则；
 *   2. 可以单测，不需要起终端。
 */
import type { ChatMessage } from '../llm/types.js';

export type HistoryBlock =
  | { kind: 'user'; text: string }
  | { kind: 'md'; text: string }
  | { kind: 'tool'; text: string };

export interface HistoryOptions {
  /** 最多重放多少条消息（从尾部取），默认 200 */
  maxMessages?: number;
  /** 单个块最大字符数，超出截断并标记，默认 4000 */
  maxChars?: number;
}

const TRUNCATED = '\n… (truncated)';

function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + TRUNCATED;
}

/**
 * 重放规则：
 *   - user + 字符串内容、且不以 "[" 开头 → 用户发言
 *     （"[" 开头的是注入的检索结果/通知：[S1] / [NODE MIND] / [TRAIT GRAPH] / [Agent ...]）
 *   - user + 数组内容 → 跳过（tool_result 等复合内容）
 *   - assistant + 数组内容 → 文本块合并成一条 md；tool_use 名字合并成一行 tool
 *     同一轮多个工具合成一行，避免恢复时刷屏
 */
export function historyToBlocks(
  messages: ChatMessage[],
  opts: HistoryOptions = {},
): HistoryBlock[] {
  const maxMessages = opts.maxMessages ?? 200;
  const maxChars = opts.maxChars ?? 4000;
  const slice = messages.slice(Math.max(0, messages.length - maxMessages));
  const blocks: HistoryBlock[] = [];

  for (const m of slice) {
    if (m.role === 'user') {
      if (typeof m.content !== 'string') continue;
      const text = m.content.trim();
      if (!text || text.startsWith('[')) continue;
      blocks.push({ kind: 'user', text: clamp(text, maxChars) });
      continue;
    }

    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const parts = m.content as Array<{ type?: string; text?: string; name?: string }>;

    const texts = parts
      .filter(b => b.type === 'text' && (b.text ?? '').trim().length > 0)
      .map(b => (b.text as string).trim());
    if (texts.length > 0) blocks.push({ kind: 'md', text: clamp(texts.join('\n\n'), maxChars) });

    const names = parts
      .filter(b => b.type === 'tool_use' && typeof b.name === 'string' && b.name.length > 0)
      .map(b => b.name as string);
    if (names.length > 0) blocks.push({ kind: 'tool', text: names.join(', ') });
  }

  return blocks;
}

/** 恢复提示行的统计信息（用于界面上的一句话摘要） */
export function historyStats(messages: ChatMessage[]): { messages: number; users: number; assistantTexts: number } {
  let users = 0;
  let assistantTexts = 0;
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string' && m.content.trim() && !m.content.trim().startsWith('[')) users++;
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      if (m.content.some((b: any) => b.type === 'text' && (b.text ?? '').trim())) assistantTexts++;
    }
  }
  return { messages: messages.length, users, assistantTexts };
}
