/**
 * Anthropic Provider 实现
 */

import { z } from 'zod/v4';
import { resolveDescription, type Tools } from '../tools/core/Tool.js';
import type { LLMProvider, ChatMessage, LLMResponse } from './types.js';
import { fetchWithRetry } from './retry.js';

export const anthropicProvider: LLMProvider = {
  name: 'anthropic',

  formatTools(tools: Tools) {
    return Promise.all(tools.map(async t => ({
      name: t.name,
      description: await resolveDescription(t.description),
      input_schema: (z as unknown as { toJSONSchema: (s: z.ZodType) => Record<string, unknown> }).toJSONSchema(t.inputSchema),
    })));
  },

  formatToolResult(toolCallId: string, output: string): ChatMessage {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolCallId, content: output }],
    };
  },

  async call(systemPrompt: string, messages: ChatMessage[], apiKey: string, model: string, tools: unknown[], openaiBase?: string, maxTokens?: number, signal?: AbortSignal): Promise<LLMResponse> {
    // 只保留 API 认识的字段：tool_use 块里可能带有内部标记（如 _argError/_rawArgs），
    // Anthropic 对未知字段是严格的，跨 provider 切换时会 400。
    const clean = (content: unknown): unknown => {
      if (typeof content === 'string' || !Array.isArray(content)) return content;
      return content.map(b => {
        const blk = b as Record<string, unknown>;
        if (blk && blk.type === 'tool_use') {
          return { type: 'tool_use', id: blk.id, name: blk.name, input: blk.input ?? {} };
        }
        if (blk && blk.type === 'tool_result') {
          return { type: 'tool_result', tool_use_id: blk.tool_use_id, content: blk.content };
        }
        return b;
      });
    };
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens ?? 384000,
      system: systemPrompt,
      messages: messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: clean(m.content) })),
      tools,
    };
    const { status, ok, text } = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    }, 10, 120_000, 600_000, signal);
    if (!ok) throw new Error(`API ${status}: ${text.slice(0, 200)}`);
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Invalid JSON from API: ${(e as Error).message}`.slice(0, 200));
    }
    return {
      content: (d.content as Array<unknown>) || [],
      stop_reason: (d.stop_reason as string) || '',
    };
  },
};
