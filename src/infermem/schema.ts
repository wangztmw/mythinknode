/**
 * infermem — 知识 DAG 的统一数据契约。
 *
 * 这是「统一结果内容」的载体:每个抽取 worker 都吐 ExtractedAtom[],
 * reducer 据此合并成全局 DAG。纯 zod schema,不碰 fs/crypto(身份逻辑在 identity.ts)。
 */
import { z } from 'zod/v4';

export const AtomKind = z.enum([
  'concept',     // 命名概念/对象 —— 跨书合并的锚点
  'definition',  // 形式定义(定义项 → 被定义项)
  'theorem',     // 定理/引理/推论/公理
  'formula',     // 公式/方程/不等式
  'table',       // 数据表/真值表/查表
  'case',        // 案例/例子/反例 —— 永不合并,总是独立节点
]);
export type AtomKind = z.infer<typeof AtomKind>;

export const PropositionType = z.enum([
  'axiom', 'definition', 'lemma', 'theorem', 'corollary', 'proposition', 'claim', 'conjecture',
]);
export type PropositionType = z.infer<typeof PropositionType>;

export const EdgeRelation = z.enum([
  'defines',       // definition/concept → 所定义的概念
  'derives',       // A 推导出 B(B 建立在 A 上)
  'uses',          // B 依赖/借用 A(A 是工具或前提)
  'generalizes',   // A 更一般,B 是特例
  'illustrates',   // case → 它说明的概念/定理
  'part_of',       // B 是 A 的组成部分
  'equivalent',    // A ⟺ B(等价定义/等价表述)
  'contradicts',   // A 与 B 冲突
  'related',       // 兜底,未定类型
]);
export type EdgeRelation = z.infer<typeof EdgeRelation>;

/** 原文定位 —— 决策 #2:指向 docs/<docId>/content.json 的数组下标 + 段内字符偏移,不存原文 */
export const Provenance = z.object({
  docId: z.string(),
  segIndex: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
});
export type Provenance = z.infer<typeof Provenance>;

export const Edge = z.object({
  id: z.string(),                                   // sha1(from + relation + to) —— 幂等 upsert
  from: z.string(),                                 // atomId(前提/来源)
  to: z.string(),                                   // atomId(依赖方/被引用方)
  relation: EdgeRelation,
  evidence: z.string().min(1),                      // 原文原句 —— 反幻觉门,无证据无边
  confidence: z.number().min(0).max(1),
  source: z.enum(['explicit', 'inferred', 'manual']), // 显式线索 / 隐式推断 / 人工
});
export type Edge = z.infer<typeof Edge>;

/** 抽取时的「本地线索」:用名字引用跨块/跨书目标,reducer 再解析成 Edge */
export const ReferenceHint = z.object({
  target: z.string(),                 // 指向的命名概念/定理名
  relation: EdgeRelation,
  evidence: z.string().min(1),
  direction: z.enum(['outgoing', 'incoming']).default('outgoing'),
});
export type ReferenceHint = z.infer<typeof ReferenceHint>;

/** worker 产出的「裸原子」—— 无全局 id / identityKey / provenance,由 reducer 盖章 */
export const ExtractedAtom = z.object({
  kind: AtomKind,
  title: z.string(),                          // 规范名,展示 + 身份
  aliases: z.array(z.string()).default([]),   // 跨书别名(Bayes' rule / Bayes' theorem)
  scope: z.array(z.string()).min(1),          // 层级路径,如 ['probability','bayesian']
  statement: z.string(),                      // 精确内容:定义原文 / 定理断言
  keywords: z.array(z.string()).min(1),
  // —— kind 专属(不匹配该 kind 则为空) ——
  propositionType: PropositionType.optional(),        // kind=theorem
  conditions: z.array(z.string()).optional(),         // 定理假设
  conclusion: z.string().optional(),                  // 定理结论
  formula: z.string().optional(),                     // kind=formula,LaTeX
  symbols: z.record(z.string(), z.string()).optional(), // 公式变量 → 含义/量纲
  tableColumns: z.array(z.string()).optional(),       // kind=table
  tableRows: z.array(z.array(z.string())).optional(), // kind=table
  exampleOf: z.string().optional(),                   // kind=case: 说明哪个概念(identityKey 或 title)
  references: z.array(ReferenceHint).optional(),      // 本地线索
  confidence: z.number().min(0).max(1).default(1),
});
export type ExtractedAtom = z.infer<typeof ExtractedAtom>;

/** reducer 盖章后的完整原子(存储形态) */
export const KnowledgeAtom = ExtractedAtom.extend({
  id: z.string(),                          // 稳定全局 ID = 由 identityKey 派生,幂等
  identityKey: z.string(),                 // 合并键(identity.ts 生成)
  provenance: z.array(Provenance).min(1),  // 合并后多个(跨书)
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KnowledgeAtom = z.infer<typeof KnowledgeAtom>;

/** worker 的统一输出 */
export const ChunkExtraction = z.object({
  atoms: z.array(ExtractedAtom),
  danglingRefs: z.array(ReferenceHint).optional(), // 无法定位 target 时上报,reducer 解析
});
export type ChunkExtraction = z.infer<typeof ChunkExtraction>;

// Corpus 元信息(corpusId → 一棵知识树)定义在 store.ts(纯存储层,非 LLM 输出,无需 zod)
