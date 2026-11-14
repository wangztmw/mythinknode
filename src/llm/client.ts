/**
 * LLM 客户端 — 封装 API 密钥、模型、工具格式、并发控制
 * Agent 只需调 client.chat(messages) → LLMResponse
 */
import type { LLMClient, LLMResponse, ChatMessage, LLMProvider } from './types.js';
import type { Tools } from '../tools/core/Tool.js';
import { ConcurrencyLimiter } from './concurrency.js';
import { UserAbortError } from '../agent/interrupt.js';

export function createLLMClient(config: {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  openaiBase: string;
  tools: Tools;
  systemPrompt: string;
  maxConcurrency?: number;
  maxTokensCap?: number;
}): LLMClient {
  const limiter = new ConcurrencyLimiter(config.maxConcurrency ?? 2);
  let currentTools: Tools = config.tools;

  return {
    updateTools(tools: Tools): void {
      currentTools = tools;
    },

    async chat(
      messages: ChatMessage[],
      systemPrompt?: string,
      maxTokens?: number,
      signal?: AbortSignal,
    ): Promise<LLMResponse> {
      // 已经中断就不必排队等配额
      if (signal?.aborted) throw new UserAbortError();
      await limiter.acquire();
      try {
        if (signal?.aborted) throw new UserAbortError();
        // 每次调用都重新 formatTools：工具描述可能是 async 函数，需 await 解析；
        // 动态注册工具后 currentTools 变化也能即时反映。
        const formattedTools = await config.provider.formatTools(currentTools);
        // 本地 ctx 有限：把云端默认 384000 钳到 maxTokensCap（如 4096）
        let effectiveMax = maxTokens;
        if (config.maxTokensCap) {
          effectiveMax = Math.min(maxTokens ?? config.maxTokensCap, config.maxTokensCap);
        }
        return await config.provider.call(
          systemPrompt ?? config.systemPrompt,
          messages,
          config.apiKey,
          config.model,
          formattedTools,
          config.openaiBase,
          effectiveMax,
          signal,
        );
      } finally {
        limiter.release();
      }
    },

    formatToolResult(toolCallId: string, output: string): ChatMessage {
      return config.provider.formatToolResult(toolCallId, output);
    },
  };
}
