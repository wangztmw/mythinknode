/**
 * MessageProcessor — 每轮 Query 循环后压缩增量消息。
 *
 * 原文存盘（raws/S{n}.json），精简版追加到上下文，同时提取关键词供记忆索引。
 */
import type { ChatMessage, LLMResponse } from '../llm/types.js';
import { saveRaw, detectMaxTag } from './session_raw.js';
import { buildCompressPrompt } from './message-processor_prompt.js';

export interface Processed {
  tag: string;
  compressed: ChatMessage[];
  keywords: string[];   // 本块提取的关键词，供记忆索引
}

/** 从压缩文本末尾解析 KEYWORDS 行，返回 { summary（剥离后）, keywords } */
function splitKeywords(text: string): { summary: string; keywords: string[] } {
  const m = text.match(/KEYWORDS[:：]\s*([^\n]+)/);
  if (!m) return { summary: text, keywords: [] };
  const keywords = m[1].split(/[,，、]/).map(k => k.trim()).filter(Boolean);
  const summary = text.replace(/KEYWORDS[:：]\s*[^\n]+/, '').trim();
  return { summary, keywords };
}

export class MessageProcessor {
  private counter: number;
  private llm: { chat: (msgs: ChatMessage[], prompt?: string) => Promise<LLMResponse> };
  private sessionId: string;

  constructor(llm: { chat: (msgs: ChatMessage[], prompt?: string) => Promise<LLMResponse> }, sessionId: string) {
    this.llm = llm;
    this.sessionId = sessionId;
    // 从已有 raws 恢复 counter，防止恢复会话后覆盖旧块
    this.counter = detectMaxTag(sessionId);
  }

  async process(delta: ChatMessage[]): Promise<Processed | null> {
    // 只有含工具调用的轮次才值得压缩——纯对话没有噪音
    const hasTools = delta.some(m => Array.isArray(m.content) && (m.content as any[]).some((b: any) => b.type === 'tool_use'));
    if (!hasTools) return null;

    const tag = `S${++this.counter}`;
    // 1. 原文存盘
    saveRaw(this.sessionId, tag, delta);

    // 2. 送 LLM 压缩（同时产关键词）
    try {
      const msgs = [...delta, { role: 'user' as const, content: buildCompressPrompt(this.counter) }];
      const r = await this.llm.chat(msgs);
      const text = (r.content as Array<{ type: string; text?: string }>)
        .filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
      const { summary, keywords } = splitKeywords(text);
      // 保留最终 assistant 回复的纯文本 + 压缩摘要。
      // 注意：tool_use 块必须连同其 tool 结果一起丢弃，否则会留下"有 tool_calls 无 tool 消息"
      // 的非法消息数组 → DeepSeek 400 (insufficient tool messages following tool_calls)。
      const finalAssistant = delta.filter(m => m.role === 'assistant').pop();
      const compressed: ChatMessage[] = [];
      if (summary) compressed.push({ role: 'user', content: `[${tag}] ${summary}` });
      if (finalAssistant) {
        if (typeof finalAssistant.content === 'string') {
          compressed.push(finalAssistant);
        } else {
          const textOnly = (finalAssistant.content as any[]).filter((b: any) => b.type === 'text');
          if (textOnly.length > 0) compressed.push({ role: 'assistant', content: textOnly });
        }
      }
      return { tag, compressed, keywords };
    } catch {
      return null; // 压缩失败，保留原文
    }
  }
}
