/**
 * merge —— 显式融合两个 corpus 的知识(决策修正:只有用户要求时才跨 corpus 合并)。
 *
 * 流程:把 source 的原子/边导入 target(按 identityKey 精确合并),再对 target 做一次
 * 语义实体消解(把「不同名同义」的源原子与 target 已有原子合并)。
 */
import type { LLMClient } from '../llm/types.js';
import { getStore, getCorpus, upsertCorpus } from './store.js';
import { resolveEntities } from './resolve.js';

export async function mergeCorpora(
  sourceId: string,
  targetId: string,
  llm: LLMClient,
): Promise<{ moved: number; merged: number }> {
  if (sourceId === targetId) return { moved: 0, merged: 0 };

  const source = getStore(sourceId);
  const target = getStore(targetId);

  let moved = 0;
  for (const atom of source.listAtoms()) {
    if (target.importAtom(atom)) moved++;
  }
  for (const edge of source.listEdges()) {
    target.putEdge(edge.from, edge.to, edge.relation, edge.evidence, edge.confidence, edge.source);
  }

  // 语义消解:不同名同义(源 vs target 已有)合并
  const { merged } = await resolveEntities(target, llm);
  target.flush();

  // 更新 target 的注册表(docIds 并集)
  const sMeta = getCorpus(sourceId);
  const tMeta = getCorpus(targetId);
  if (tMeta) {
    const docIds = [...new Set([...(tMeta.docIds ?? []), ...(sMeta?.docIds ?? [])])];
    upsertCorpus({
      corpusId: targetId,
      title: tMeta.title,
      docIds,
      status: 'done',
      atomCount: target.countAtoms(),
      edgeCount: target.countEdges(),
      updatedAt: new Date().toISOString(),
    });
  }

  return { moved, merged };
}
