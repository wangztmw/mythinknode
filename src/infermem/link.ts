/**
 * link —— 隐式边推断(决策 #4),scope 到单个 corpus。
 *
 * 显式引用(references)只能捕捉书里「明说」的线索;这里补「暗示」:
 * 对边数偏少的原子,候选(同 scope/keyword 交集)由 LLM 批量判依赖方向,命中加 inferred 边。
 */
import type { LLMClient } from '../llm/types.js';
import type { InferMemStore } from './store.js';
import { rankCandidates, judgeDirectedRelationBatch } from './semantic.js';

export async function linkImplicit(
  store: InferMemStore,
  llm: LLMClient,
  opts: { k?: number; minEdges?: number } = {},
): Promise<{ added: number }> {
  const k = opts.k ?? 8;
  const minEdges = opts.minEdges ?? 2; // 已有 ≥2 条边的原子视为「已连好」,跳过以省预算
  let added = 0;

  for (const a of store.listAtoms()) {
    const cur = store.getAtom(a.id);
    if (!cur) continue;

    const nb = store.neighbors(cur.id);
    if (nb.incoming.length + nb.outgoing.length >= minEdges) continue;

    const cands = rankCandidates(cur, store.listAtoms(), { k });
    const results = await judgeDirectedRelationBatch(llm, cur, cands);
    for (const { candidate, rel } of results) {
      if (!rel) continue;
      const cCur = store.getAtom(candidate.id);
      if (!cCur) continue;

      const fromId = rel.from === 'a' ? cur.id : cCur.id;
      const toId = rel.from === 'a' ? cCur.id : cur.id;
      const { inserted } = store.putEdge(fromId, toId, rel.relation, rel.evidence, rel.confidence, 'inferred');
      if (inserted) added++;
    }
  }
  return { added };
}
