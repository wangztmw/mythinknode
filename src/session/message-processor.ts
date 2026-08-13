/**
 * MessageProcessor — 每轮 Query 循环后压缩增量消息。
 *
 * 原文存盘（raws/S{n}.json），精简版追加到上下文。
 */
import type { ChatMessage, LLMResponse } from '../llm/types.js';
import { saveRaw } from './raw-storage.js';
import { buildCompressPrompt } from './message-processor_prompt.js';

export interface Processed {
  tag: string;
  compressed: ChatMessage[];
}

export class MessageProcessor {
  private counter = 0;
  private llm: { chat: (msgs: ChatMessage[], prompt?: string) => Promise<LLMResponse> };
  private sessionId: string;

  constructor(llm: { chat: (msgs: ChatMessage[], prompt?: string) => Promise<LLMResponse> }, sessionId: string) {
    this.llm = llm;
    this.sessionId = sessionId;
  }

  async process(delta: ChatMessage[]): Promise<Processed | null> {
    // 只有含工具调用的轮次才值得压缩——纯对话没有噪音
    const hasTools = delta.some(m => Array.isArray(m.content) && (m.content as any[]).some((b: any) => b.type === 'tool_use'));
    if (!hasTools) return null;

    const tag = `S${++this.counter}`;
    // 1. 原文存盘
    saveRaw(this.sessionId, tag, delta);

    // 2. 送 LLM 压缩
    try {
      const msgs = [...delta, { role: 'user' as const, content: buildCompressPrompt(this.counter) }];
      const r = await this.llm.chat(msgs);
      const text = (r.content as Array<{ type: string; text?: string }>)
        .filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
      // 保留最终 assistant 回复 + 压缩摘要
      const finalAssistant = delta.filter(m => m.role === 'assistant').pop();
      const compressed: ChatMessage[] = [];
      if (text) compressed.push({ role: 'user', content: `[${tag}] ${text}` });
      if (finalAssistant) compressed.push(finalAssistant);
      return { tag, compressed };
    } catch {
      return null; // 压缩失败，保留原文
    }
  }
}
