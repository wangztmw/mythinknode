/**
 * resolve —— 语义实体消解(决策 #1「同概念同构化合并」,scope 到单个 corpus)。
 *
 * 精确 identityKey 匹配在 putAtom 已做;这里处理「不同名但同义」:候选(同 kind + 同 scope/keyword 交集)
 * 由 LLM 批量判等价(一个原子一次调用判全部候选),等价则 mergeAtoms 合并。
 */
import type { LLMClient } from '../llm/types.js';
import type { InferMemStore } from './store.js';
import { rankCandidates, judgeEquivalenceBatch } from './semantic.js';

export async function resolveEntities(
  store: InferMemStore,
  llm: LLMClient,
  opts: { k?: number } = {},
): Promise<{ merged: number }> {
  const k = opts.k ?? 8;
  let merged = 0;

  // 快照遍历;每次合并后重取 store,避免操作已被吸收的节点
  for (const a of store.listAtoms()) {
    const cur = store.getAtom(a.id);
    if (!cur) continue; // 已被更早的等价判定吸收

    const cands = rankCandidates(cur, store.listAtoms(), { sameKind: true, k });
    const results = await judgeEquivalenceBatch(llm, cur, cands);
    for (const { candidate, same } of results) {
      if (!same) continue;
      const cCur = store.getAtom(candidate.id);
      if (!cCur) continue;
      store.mergeAtoms(cur.id, cCur.id);
      merged++;
    }
  }
  return { merged };
}
