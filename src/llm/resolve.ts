/**
 * LLM 入口 — 根据配置创建 LLMClient
 * AgentEngine 只依赖 LLMClient 接口，不关心具体 Provider
 */
import type { LLMClient, LLMProvider } from './types.js';
import { anthropicProvider } from './anthropic.js';
import { openaiProvider } from './openai.js';
import { createLLMClient } from './client.js';
import type { Tools } from '../tools/core/Tool.js';

export function resolveLLM(config: {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  openaiBase: string;
  tools: Tools;
  systemPrompt: string;
  maxConcurrency?: number;
}): LLMClient {
  const provider: LLMProvider = config.provider === 'anthropic' ? anthropicProvider : openaiProvider;
  return createLLMClient({ ...config, provider });
}
