/**
 * Anthropic Provider 实现
 */

import { z } from 'zod/v4';
import type { Tools } from '../tools/core/Tool.js';
import type { LLMProvider, ChatMessage, LLMResponse } from './types.js';
import { fetchWithRetry } from './retry.js';

export const anthropicProvider: LLMProvider = {
  name: 'anthropic',

  formatTools(tools: Tools) {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: (z as unknown as { toJSONSchema: (s: z.ZodType) => Record<string, unknown> }).toJSONSchema(t.inputSchema),
    }));
  },

  formatToolResult(toolCallId: string, output: string): ChatMessage {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolCallId, content: output }],
    };
  },

  async call(systemPrompt: string, messages: ChatMessage[], apiKey: string, model: string, tools: unknown[]): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content })),
      tools,
    };
    const r = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json() as Record<string, unknown>;
    return {
      content: (d.content as Array<unknown>) || [],
      stop_reason: (d.stop_reason as string) || '',
    };
  },
};
