/**
 * LLM 客户端 — 封装 API 密钥、模型、工具格式、并发控制
 * Agent 只需调 client.chat(messages) → LLMResponse
 */
import type { LLMClient, LLMResponse, ChatMessage, LLMProvider } from './types.js';
import type { Tools } from '../tools/core/Tool.js';
import { ConcurrencyLimiter } from './concurrency.js';

export function createLLMClient(config: {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  openaiBase: string;
  tools: Tools;
  systemPrompt: string;
  maxConcurrency?: number;
}): LLMClient {
  const limiter = new ConcurrencyLimiter(config.maxConcurrency ?? 2);
  const formattedTools = config.provider.formatTools(config.tools);

  return {
    async chat(messages: ChatMessage[], systemPrompt?: string): Promise<LLMResponse> {
      await limiter.acquire();
      try {
        return await config.provider.call(
          systemPrompt ?? config.systemPrompt,
          messages,
          config.apiKey,
          config.model,
          formattedTools,
          config.openaiBase,
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
