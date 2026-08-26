/**
 * InferQuery —— 查询/管理工具:检索/读/遍历某棵知识树(corpus),或显式融合两棵树。
 * 每个 corpus = 一次 ingest(一本书或一次性读的一批书),默认独立。
 */
import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';
import { getStore, listCorpora, type InferMemStore } from '../../../infermem/store.js';
import { normalizeName } from '../../../infermem/identity.js';
import { listIngestJobs, getInfermemLLM } from '../../../infermem/ingest.js';
import { mergeCorpora } from '../../../infermem/merge.js';
import type { LLMClient } from '../../../llm/types.js';

const inputSchema = z.object({
  action: z.enum(['status', 'query', 'read', 'walk', 'merge']).describe('status=列出所有知识树 / query=检索 / read=读原子+邻居 / walk=依赖锥 / merge=显式融合两棵树'),
  corpusId: z.string().optional().describe('目标知识树(缺省=最近摄入的知识树)'),
  atomId: z.string().optional().describe('read/walk: 原子 id'),
  term: z.string().optional().describe('query: 检索词'),
  direction: z.enum(['up', 'down']).optional().describe('walk: up=前置依赖(默认), down=下游影响'),
  source: z.string().optional().describe('merge: 源知识树 corpusId(并入 corpusId)'),
});

function resolveCorpusId(corpusId?: string): string | null {
  if (corpusId) return corpusId;
  const corpora = listCorpora();
  return corpora.length > 0 ? corpora[0].corpusId : null;
}

/** 传递闭包 BFS:up=沿入边找前置,down=沿出边找下游 */
function walkCone(store: InferMemStore, startId: string, dir: 'up' | 'down'): string[] {
  const seen = new Set<string>([startId]);
  const queue = [startId];
  const result: string[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    const nb = store.neighbors(cur);
    const nextEdges = dir === 'up' ? nb.incoming : nb.outgoing;
    for (const e of nextEdges) {
      const nxt = dir === 'up' ? e.from : e.to;
      if (!seen.has(nxt)) { seen.add(nxt); queue.push(nxt); result.push(nxt); }
    }
  }
  return result;
}

export const InferQueryTool = buildTool({
  name: 'InferQuery',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  async call(input: z.infer<typeof inputSchema>, ctx: ToolUseContext): Promise<ToolResult<string>> {
    switch (input.action) {
      case 'status': {
        const corpora = listCorpora();
        if (corpora.length === 0) return { data: '尚无知识树。用 Infer(path) 摄入一本书开始。' };
        let out = `**infermem 知识树 (${corpora.length}):**\n`;
        for (const c of corpora) {
          out += `- **${c.corpusId}** [${c.status}] ${c.title}: ${c.atomCount} atoms, ${c.edgeCount} edges, ${c.docIds.length} docs\n`;
        }
        const running = listIngestJobs().filter(j => j.status === 'running');
        if (running.length > 0) {
          out += `\n**进行中:**\n`;
          for (const j of running) out += `- ${j.jobId}: ${j.segmentsDone}/${j.segmentsTotal} 段 → ${j.corpusId}\n`;
        }
        return { data: out };
      }

      case 'query': {
        const corpusId = resolveCorpusId(input.corpusId);
        if (!corpusId) return { data: '尚无知识树。用 Infer(path) 摄入。' };
        if (!input.term) return { data: 'Error: term required for query.' };
        const store = getStore(corpusId);
        const k = normalizeName(input.term);
        const hits = store.listAtoms().filter(a =>
          normalizeName(a.title).includes(k) ||
          a.aliases.some(al => normalizeName(al).includes(k)) ||
          a.keywords.some(kw => normalizeName(kw).includes(k))
        ).slice(0, 20);
        if (hits.length === 0) return { data: `"${input.term}" 无匹配(在 ${corpusId} 中)。` };
        return { data: hits.map(a => `- **${a.id}** [${a.kind}] ${a.title} (${a.scope.join('.')})`).join('\n') };
      }

      case 'read': {
        const corpusId = resolveCorpusId(input.corpusId);
        if (!corpusId) return { data: '尚无知识树。用 Infer(path) 摄入。' };
        if (!input.atomId) return { data: 'Error: atomId required for read.' };
        const store = getStore(corpusId);
        const a = store.getAtom(input.atomId);
        if (!a) return { data: `Atom "${input.atomId}" not found (in ${corpusId}).` };
        const nb = store.neighbors(input.atomId);

        let out = `## ${a.title} [${a.kind}]\n**ID:** ${a.id}\n**scope:** ${a.scope.join('.')}\n**aliases:** ${a.aliases.join(', ') || '(none)'}\n\n${a.statement}`;
        if (a.kind === 'theorem') {
          if (a.conditions?.length) out += `\n\n假设: ${a.conditions.join('; ')}`;
          if (a.conclusion) out += `\n结论: ${a.conclusion}`;
        }
        if (a.formula) out += `\n\n公式: ${a.formula}`;

        if (nb.incoming.length) {
          out += `\n\n**前置依赖 (${nb.incoming.length}):** ` +
            nb.incoming.map(e => `${store.getAtom(e.from)?.title ?? e.from} (${e.relation}${e.source === 'inferred' ? '*' : ''})`).join(', ');
        }
        if (nb.outgoing.length) {
          out += `\n**下游影响 (${nb.outgoing.length}):** ` +
            nb.outgoing.map(e => `${store.getAtom(e.to)?.title ?? e.to} (${e.relation}${e.source === 'inferred' ? '*' : ''})`).join(', ');
        }
        return { data: out };
      }

      case 'walk': {
        const corpusId = resolveCorpusId(input.corpusId);
        if (!corpusId) return { data: '尚无知识树。用 Infer(path) 摄入。' };
        if (!input.atomId) return { data: 'Error: atomId required for walk.' };
        const store = getStore(corpusId);
        const dir = input.direction ?? 'up';
        const cone = walkCone(store, input.atomId, dir);
        const label = dir === 'up' ? '前置依赖' : '下游影响';
        if (cone.length === 0) return { data: `无${label}。` };
        return { data: `**${label} (${cone.length}):**\n` + cone.map(id => `- ${store.getAtom(id)?.title ?? id}`).join('\n') };
      }

      case 'merge': {
        const llm = (getInfermemLLM() ?? (ctx.engine as any)?.llm) as LLMClient | undefined;
        if (!llm) return { data: 'LLM not available.' };
        if (!input.source || !input.corpusId) return { data: 'merge 需要 source(源 corpusId) 和 corpusId(目标 corpusId)。' };
        const r = await mergeCorpora(input.source, input.corpusId, llm);
        return { data: `已把 "${input.source}" 融合进 "${input.corpusId}": 新导入 ${r.moved} 原子, 语义合并 ${r.merged} 对。` };
      }
    }
  },

  async prompt() { return `## InferQuery\n${DESCRIPTION}\nInput: { action: 'status'|'query'|'read'|'walk'|'merge', corpusId?, atomId?, term?, direction?, source? }`; },
  userFacingName: () => 'InferQuery',
  getToolUseSummary(input: Partial<z.infer<typeof inputSchema>>) {
    switch (input.action) {
      case 'status': return 'InferQuery: status';
      case 'query': return `InferQuery: query "${(input.term ?? '').slice(0, 40)}"`;
      case 'read': return `InferQuery: read ${input.atomId ?? ''}`;
      case 'walk': return `InferQuery: walk ${input.atomId ?? ''} ${input.direction ?? ''}`;
      case 'merge': return `InferQuery: merge ${input.source ?? ''} → ${input.corpusId ?? ''}`;
      default: return 'InferQuery';
    }
  },
});
