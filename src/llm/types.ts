/**
 * LLM 接口
 * 外部（AgentEngine）只依赖 LLMClient
 */
import type { Tools } from '../tools/core/Tool.js';

export interface ChatMessage {
  role: string;
  content: string | Array<unknown>;
}

export interface LLMResponse {
  content: Array<unknown>;
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/** Agent 使用的简洁接口 */
export interface LLMClient {
  chat(messages: ChatMessage[], systemPrompt?: string, maxTokens?: number): Promise<LLMResponse>;
  formatToolResult(toolCallId: string, output: string): ChatMessage;
  /** 运行时刷新工具列表（动态注册/移除工具后调用，重新 formatTools） */
  updateTools?(tools: Tools): void;
  lastUsage?: { input_tokens: number; output_tokens: number };
}

/** LLM 模块内部接口（anthropic.ts/openai.ts 实现此接口） */
export interface LLMProvider {
  name: string;
  formatTools(tools: Tools): Promise<unknown[]>;
  formatToolResult(toolCallId: string, output: string): ChatMessage;
  call(systemPrompt: string, messages: ChatMessage[], apiKey: string, model: string, tools: unknown[], openaiBase?: string, maxTokens?: number): Promise<LLMResponse>;
}
