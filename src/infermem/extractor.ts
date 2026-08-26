/**
 * extractor —— 抽取 worker:单次 llm.chat + EXTRACT_CONTRACT + zod 校验 + 带反馈重试。
 *
 * 返回 { atoms, error }:
 *   - 成功(含「合法但 0 原子」):error 为 undefined
 *   - 失败:error 非空(调用方可据此区分「空段」和「失败段」)
 *
 * 决策 #5:抽取用便宜模型(由调用方传入的 llm 决定)。
 */
import { z } from 'zod/v4';
import type { LLMClient, ChatMessage } from '../llm/types.js';
import { ExtractedAtom } from './schema.js';
import { buildExtractContract } from './extract_prompt.js';
import { parseJsonLenient } from './json.js';

export interface ExtractNeighbors {
  prevTitle?: string;
  nextTitle?: string;
}

export interface ExtractionResult {
  atoms: ExtractedAtom[];
  error?: string;
}

/** 永久错误(余额/鉴权/请求)——重试没用,立即失败 */
function isPermanentError(msg: string): boolean {
  const m = msg.toLowerCase();
  return /api 4\d\d/.test(m) || m.includes('insufficient balance');
}

function extractText(response: { content: Array<unknown> }): string {
  return (response.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('\n')
    .trim();
}

export async function extractChunk(
  llm: LLMClient,
  chunkText: string,
  neighbors: ExtractNeighbors = {},
  maxTokens = 16000,
): Promise<ExtractionResult> {
  const system = buildExtractContract(neighbors);
  const messages: ChatMessage[] = [{ role: 'user', content: chunkText }];
  let lastError = 'no output';
  let text = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await llm.chat(messages, system, maxTokens);
      text = extractText(response);
      const parsed = parseJsonLenient(text) as any;

      // 兼容两种形态:{ atoms: [...] } 或裸数组
      const raw = parsed && !Array.isArray(parsed) && Array.isArray(parsed.atoms) ? parsed.atoms : parsed;

      if (Array.isArray(raw)) {
        const v = z.array(ExtractedAtom).safeParse(raw);
        if (v.success) return { atoms: v.data };
        lastError = v.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      } else {
        lastError = `unexpected shape: ${text.slice(0, 120)}`;
      }
    } catch (e) {
      lastError = (e as Error).message;
      if (isPermanentError(lastError)) return { atoms: [], error: lastError };  // 余额/鉴权 → 立即失败,不重试
    }

    // 带反馈重试:把失败原因 + 原文回传,让模型重新输出
    messages.push({ role: 'assistant', content: text ?? '(empty)' });
    messages.push({ role: 'user', content: `[校验失败] ${lastError}\n请重新只输出 JSON 对象 {"atoms": [...]}。` });
  }

  return { atoms: [], error: lastError };
}
