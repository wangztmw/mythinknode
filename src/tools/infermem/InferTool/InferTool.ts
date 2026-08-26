/**
 * Infer —— 构建工具:把一篇 markdown 编译进全局知识 DAG。
 * 查询用 InferQuery。ingest 走 ingestMarkdown(抽取 + 语义消解 + 隐式推断 + 落盘)。
 */
import { z } from 'zod/v4';
import { readFileSync } from 'node:fs';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';
import { startIngest, getInfermemLLM } from '../../../infermem/ingest.js';
import type { LLMClient } from '../../../llm/types.js';

const inputSchema = z.object({
  path: z.string().describe('markdown 文件路径'),
  title: z.string().optional().describe('可选标题,缺省用文件名'),
  docId: z.string().optional().describe('可选 docId,缺省由标题生成'),
  corpusId: z.string().optional().describe('可选 corpusId(知识树标识)。缺省=docId;多本书用同一 corpusId 摄入 = 一次性读多本书,合并进同一棵树'),
});

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'doc';
}

export const InferTool = buildTool({
  name: 'Infer',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  async call(input: z.infer<typeof inputSchema>, ctx: ToolUseContext): Promise<ToolResult<string>> {
    const llm = (getInfermemLLM() ?? (ctx.engine as any)?.llm) as LLMClient | undefined;
    if (!llm) return { data: 'LLM not available (engine.llm missing).' };

    let md: string;
    try { md = readFileSync(input.path, 'utf-8'); }
    catch (e) { return { data: `Error reading ${input.path}: ${(e as Error).message}` }; }

    const title = input.title || input.path.split('/').pop() || 'untitled';
    const docId = input.docId || slugify(title);
    const corpusId = input.corpusId || docId;
    const { jobId, started } = startIngest(corpusId, llm, { docId, title, sourcePath: input.path, markdown: md });

    if (!started) {
      return { data: `已有 ingest 任务在跑 (${jobId}),拒绝启动第二个。用 InferQuery(action='status') 查看进度。` };
    }
    return {
      data: `已启动后台 ingest 任务 ${jobId} ("${title}")。` +
        `\n构建在后台进行,用 InferQuery(action='status') 查看进度;完成后用 InferQuery(action='query'|'read'|'walk') 查询。`,
    };
  },

  async prompt() { return `## Infer\n${DESCRIPTION}\nInput: { path, title?, docId? }`; },
  userFacingName: () => 'Infer',
  getToolUseSummary(input: Partial<z.infer<typeof inputSchema>>) {
    return `Infer: ingest ${input.path?.split('/').pop() ?? ''}`;
  },
});
