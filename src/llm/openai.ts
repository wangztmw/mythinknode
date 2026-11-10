/**
 * OpenAI / DeepSeek Provider 实现
 */

import { z } from 'zod/v4';
import { resolveDescription, type Tools } from '../tools/core/Tool.js';
import type { LLMProvider, ChatMessage, LLMResponse } from './types.js';
import { fetchWithRetry } from './retry.js';
import { parseToolArgs } from './toolargs.js';

export const openaiProvider: LLMProvider = {
  name: 'openai',

  formatTools(tools: Tools) {
    return Promise.all(tools.map(async t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: await resolveDescription(t.description),
        parameters: (z as unknown as { toJSONSchema: (s: z.ZodType) => Record<string, unknown> }).toJSONSchema(t.inputSchema),
      },
    })));
  },

  formatToolResult(toolCallId: string, output: string): ChatMessage {
    return { role: 'tool', tool_call_id: toolCallId, content: output } as unknown as ChatMessage;
  },

  async call(systemPrompt: string, messages: ChatMessage[], apiKey: string, model: string, tools: unknown[], openaiBase?: string, maxTokens?: number): Promise<LLMResponse> {
    const baseUrl = openaiBase || 'https://api.deepseek.com';
    const apiMessages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];

    for (const m of messages) {
      if (m.role === 'user') {
        apiMessages.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        const entry: Record<string, unknown> = { role: 'assistant' };
        if (typeof m.content === 'string') {
          entry.content = m.content;
        } else {
          const blocks = m.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
          entry.content = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n') || null;
          const tcs = blocks.filter(b => b.type === 'tool_use');
          if (tcs.length) {
            entry.tool_calls = tcs.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }));
          }
        }
        // 跳过空 assistant 消息（既无 content 又无 tool_calls）——否则 DeepSeek 报
        // "Invalid assistant message: content or tool_calls must be set" 400。
        // 来源：推理模型在工具结果后可能返回空回合，被 query_loop push 成空 content。
        if (!entry.content && !entry.tool_calls) continue;
        apiMessages.push(entry);
      } else if (m.role === 'tool') {
        const toolMsg = m as unknown as Record<string, unknown>;
        apiMessages.push({
          role: 'tool',
          tool_call_id: toolMsg.tool_call_id,
          content: m.content,
        });
      }
    }

    const { status, ok, text } = await fetchWithRetry(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: apiMessages,
        max_tokens: maxTokens ?? 384000,
        tools,
        tool_choice: 'auto',
      }),
    });
    if (!ok) throw new Error(`API ${status}: ${text.slice(0, 200)}`);
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Invalid JSON from API: ${(e as Error).message}`.slice(0, 200));
    }
    const choice = (d.choices as Array<Record<string, unknown>>)?.[0];
    const msg = choice?.message as Record<string, unknown> | undefined;

    if (!msg) throw new Error('API response missing message field — refusing to create empty assistant message');

    const content: Array<unknown> = [];
    if (msg.content) content.push({ type: 'text', text: msg.content });
    if (msg.tool_calls) {
      for (const tc of (msg.tool_calls as Array<Record<string, unknown>>)) {
        const fn = tc.function as Record<string, unknown>;
        // 模型给的 arguments 常常不是合法 JSON（单引号/尾逗号/裸 key…）。
        // 这里容错解析并**绝不抛**：解析失败时挂 _argError，由 query_loop 当成
        // 工具结果反馈给模型重发 —— 否则整轮 agentLoop 会被打成 crashed。
        const parsed = parseToolArgs(fn.arguments);
        const block: Record<string, unknown> = {
          type: 'tool_use',
          id: tc.id,
          name: fn.name,
          input: parsed.ok ? parsed.value : {},
        };
        if (!parsed.ok) {
          block._argError = parsed.error;
          block._rawArgs = typeof fn.arguments === 'string' ? fn.arguments.slice(0, 400) : String(fn.arguments).slice(0, 400);
        }
        content.push(block);
      }
    }
    const u = d.usage as Record<string, number> | undefined;
    return {
      content,
      stop_reason: (choice.finish_reason as string) === 'tool_calls' ? 'tool_use' : 'end_turn',
      usage: u ? { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens } : undefined,
    };
  },
};
