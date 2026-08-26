/**
 * reducer —— 归并:插入原子(按 identityKey 精确合并)+ 解析引用 → 边。
 *
 * 拆成两段以支持「逐块增量落盘」:
 *   - insertAtoms:每块抽完即可调(精确合并 + 收集引用),可随时 flush
 *   - resolveExactRefs:全部原子就位后统一解析(名字索引需要全量原子)
 *
 * 精确名字匹配在 resolveExactRefs 内做(免费、确定);悬空引用由 resolveDanglingRefs 做语义兜底(决策 #5)。
 * store 由调用方传入(per-corpus),不依赖全局单例。
 */
import type { ExtractedAtom, Provenance, ReferenceHint, KnowledgeAtom } from './schema.js';
import type { LLMClient } from '../llm/types.js';
import type { InferMemStore } from './store.js';
import { normalizeName } from './identity.js';
import { judgeRefTarget } from './semantic.js';

export interface ChunkBatch {
  docId: string;
  segIndex: number;
  atoms: ExtractedAtom[];
}

export interface PendingRef {
  fromAtomId: string;
  ref: ReferenceHint;
}

/** 阶段 A:插入原子(精确 identityKey 合并),返回待解析引用 */
export function insertAtoms(store: InferMemStore, batches: ChunkBatch[]): PendingRef[] {
  const pending: PendingRef[] = [];
  for (const b of batches) {
    const prov: Provenance = { docId: b.docId, segIndex: b.segIndex, offset: 0 };
    for (const atom of b.atoms) {
      const { atomId } = store.putAtom(atom, prov);
      for (const ref of atom.references ?? []) pending.push({ fromAtomId: atomId, ref });
    }
  }
  return pending;
}

/** 阶段 B:精确名字解析引用 → 边,返回悬空(歧义或无匹配) */
export function resolveExactRefs(store: InferMemStore, pending: PendingRef[]): PendingRef[] {
  const nameIndex = new Map<string, string[]>();
  for (const a of store.listAtoms()) {
    for (const name of [a.title, ...a.aliases]) {
      const k = normalizeName(name);
      if (!k) continue;
      const ids = nameIndex.get(k) ?? [];
      ids.push(a.id);
      nameIndex.set(k, ids);
    }
  }

  const dangling: PendingRef[] = [];
  for (const p of pending) {
    const ids = nameIndex.get(normalizeName(p.ref.target));
    if (!ids || ids.length !== 1) { dangling.push(p); continue; } // 歧义或无匹配 → 悬空
    const targetId = ids[0];
    if (targetId === p.fromAtomId) continue;
    if (p.ref.direction === 'outgoing') store.putEdge(targetId, p.fromAtomId, p.ref.relation, p.ref.evidence, 0.8, 'explicit');
    else store.putEdge(p.fromAtomId, targetId, p.ref.relation, p.ref.evidence, 0.8, 'explicit');
  }
  return dangling;
}

/** 引用名 token 匹配的候选(精确名字没匹配上时用) */
function nameCandidates(target: string, atoms: KnowledgeAtom[], k = 8): KnowledgeAtom[] {
  const tk = normalizeName(target);
  const toks = tk.split('-').filter(t => t.length > 0);
  return atoms.filter(a => {
    const names = [a.title, ...a.aliases].map(normalizeName);
    return names.some(n => n === tk || toks.some(t => t && n.includes(t)));
  }).slice(0, k);
}

/** 语义兜底:悬空引用用 LLM 从名字候选中挑目标 → 边 */
export async function resolveDanglingRefs(
  store: InferMemStore,
  llm: LLMClient,
  dangling: PendingRef[],
  opts: { k?: number } = {},
): Promise<{ resolved: number }> {
  const k = opts.k ?? 8;
  let resolved = 0;

  for (const p of dangling) {
    const from = store.getAtom(p.fromAtomId);
    if (!from) continue;
    const cands = nameCandidates(p.ref.target, store.listAtoms(), k);
    const targetId = await judgeRefTarget(llm, p.ref.target, cands);
    if (!targetId || targetId === p.fromAtomId) continue;
    if (p.ref.direction === 'outgoing') store.putEdge(targetId, p.fromAtomId, p.ref.relation, p.ref.evidence, 0.8, 'explicit');
    else store.putEdge(p.fromAtomId, targetId, p.ref.relation, p.ref.evidence, 0.8, 'explicit');
    resolved++;
  }
  return { resolved };
}
