/**
 * semantic —— 语义判断层(决策 #4 隐式推断 + 决策 #1 跨书语义消解共用的大脑)。
 *
 * 三个 LLM 判断:
 *   - judgeEquivalence:两个原子是不是同一个概念(可能不同名)→ 实体消解用
 *   - judgeDirectedRelation:A/B 之间有没有依赖、方向是什么 → 隐式边推断用
 *   - judgeRefTarget:一个引用名指向哪个原子 → 显式引用的语义兜底用
 *
 * 候选生成(rankCandidates)用「同顶层 scope + keyword 交集」做阻塞,把 O(n²) 的 LLM 调用压到 top-K。
 */
import type { LLMClient } from '../llm/types.js';
import type { KnowledgeAtom, EdgeRelation } from './schema.js';
import { normalizeName } from './identity.js';
import { parseJsonLenient } from './json.js';

function extractText(response: { content: Array<unknown> }): string {
  return (response.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('\n')
    .trim();
}

/** 候选排名:同顶层 scope 或 keyword 交集,按重叠度打分,top-K 阻塞 */
export function rankCandidates(
  target: KnowledgeAtom,
  atoms: KnowledgeAtom[],
  opts: { sameKind?: boolean; k?: number } = {},
): KnowledgeAtom[] {
  const { sameKind = false, k = 8 } = opts;
  const tkw = new Set(target.keywords.map(normalizeName));
  const scored: Array<{ a: KnowledgeAtom; score: number }> = [];

  for (const a of atoms) {
    if (a.id === target.id) continue;
    if (sameKind && a.kind !== target.kind) continue;
    const sameScope = a.scope[0] === target.scope[0];
    const overlap = a.keywords.map(normalizeName).filter(k => tkw.has(k)).length;
    if (!sameScope && overlap === 0) continue;
    const scopeOverlap = a.scope.filter(s => target.scope.includes(s)).length;
    scored.push({ a, score: overlap * 3 + scopeOverlap * 2 + (sameScope ? 1 : 0) });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, k).map(x => x.a);
}

async function ask(llm: LLMClient, prompt: string): Promise<any> {
  const resp = await llm.chat([{ role: 'user', content: prompt }]);
  return parseJsonLenient(extractText(resp));
}

function brief(a: KnowledgeAtom): string {
  const cond = a.conditions?.length ? `\n  假设: ${a.conditions.join('; ')}` : '';
  const concl = a.conclusion ? `\n  结论: ${a.conclusion}` : '';
  const formula = a.formula ? `\n  公式: ${a.formula}` : '';
  return `[${a.kind}] ${a.title} (scope: ${a.scope.join('.')})\n  ${a.statement}${cond}${concl}${formula}`;
}

export interface DirectedRelation {
  from: 'a' | 'b';
  relation: EdgeRelation;
  confidence: number;
  evidence: string;
}

/** 一次 LLM 调用返回一个 JSON 数组(批量判断用);失败返回 null */
async function askArray(llm: LLMClient, prompt: string): Promise<any[] | null> {
  try {
    const r = await ask(llm, prompt);
    return Array.isArray(r) ? r : null;
  } catch { return null; }
}

export interface EquivalenceResult {
  candidate: KnowledgeAtom;
  same: boolean;
}

/** 批量:一个 LLM 调用判 A 与所有候选是否同义(替代逐个 judgeEquivalence) */
export async function judgeEquivalenceBatch(llm: LLMClient, a: KnowledgeAtom, candidates: KnowledgeAtom[]): Promise<EquivalenceResult[]> {
  if (candidates.length === 0) return [];
  const prompt = `判断 A 与下面每个候选是否指同一个知识点(可能名字/表述不同,但语义等价)。

A ${brief(a)}

候选(编号 = 输出数组下标):
${candidates.map((c, i) => `[${i}] ${brief(c)}`).join('\n\n')}

只输出 JSON 数组,长度=${candidates.length},每个元素 {"same": true|false},按编号顺序。`;
  const arr = await askArray(llm, prompt);
  return candidates.map((c, i) => ({ candidate: c, same: arr?.[i]?.same === true }));
}

export interface RelationResult {
  candidate: KnowledgeAtom;
  rel: DirectedRelation | null;
}

/** 批量:一个 LLM 调用判 A 与所有候选之间的依赖方向(替代逐个 judgeDirectedRelation) */
export async function judgeDirectedRelationBatch(llm: LLMClient, a: KnowledgeAtom, candidates: KnowledgeAtom[]): Promise<RelationResult[]> {
  if (candidates.length === 0) return [];
  const prompt = `判断 A 与下面每个候选之间是否有「谁依赖谁」的关系。
from="a" = A 是候选的前提;from="b" = 候选是 A 的前提。

A ${brief(a)}

候选(编号 = 输出数组下标):
${candidates.map((c, i) => `[${i}] ${brief(c)}`).join('\n\n')}

关系类型: derives | uses | generalizes | part_of | none
只输出 JSON 数组,长度=${candidates.length},每个元素:
{"from": "a"|"b"|null, "relation": "...", "confidence": 0到1, "evidence": "依据"}
无关系时 {"from": null, "relation": "none"}。按编号顺序。`;
  const arr = await askArray(llm, prompt);
  return candidates.map((c, i) => {
    const r = arr?.[i];
    if (!r || (r.from !== 'a' && r.from !== 'b')) return { candidate: c, rel: null };
    if (!['derives', 'uses', 'generalizes', 'part_of'].includes(r.relation)) return { candidate: c, rel: null };
    return {
      candidate: c,
      rel: {
        from: r.from as 'a' | 'b',
        relation: r.relation as EdgeRelation,
        confidence: typeof r.confidence === 'number' ? Math.min(1, Math.max(0, r.confidence)) : 0.7,
        evidence: typeof r.evidence === 'string' ? r.evidence : '(推断)',
      },
    };
  });
}

/** 引用名 target 指向哪个候选原子(语义兜底)。返回 atomId 或 null */
export async function judgeRefTarget(
  llm: LLMClient,
  target: string,
  candidates: KnowledgeAtom[],
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const menu = candidates.map(c => `- [${c.id}] ${brief(c)}`).join('\n');
  const prompt = `引用目标: "${target}"

候选原子:
${menu}

选出最匹配的原子 id;若都不匹配返回 "none"。只输出 JSON: {"id": "..."}`;
  try {
    const r = await ask(llm, prompt);
    return typeof r?.id === 'string' && r.id !== 'none' ? r.id : null;
  } catch { return null; }
}
