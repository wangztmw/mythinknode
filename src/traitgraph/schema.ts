/**
 * traitgraph — 会话级「思维-执行」轨迹图的数据契约。
 *
 * 节点 = 模型某时刻的思维状态(任务目标 + 计划 + 打算尝试的方向)。
 * 边   = 一次实际尝试(做了什么 + 得到什么结果)。
 * 走不通时折返,把这条边标 dead。
 *
 * 纯 zod schema,不碰 fs(读写逻辑在 store.ts / session_raw.ts)。
 */
import { z } from 'zod/v4';

export const TraitNodeStatus = z.enum(['active', 'done', 'failed', 'abandoned']);
export type TraitNodeStatus = z.infer<typeof TraitNodeStatus>;

/** 节点 —— 一个思维状态 */
export const TraitNode = z.object({
  id: z.string(),          // "T1" 或显式 id;根/分支锚点
  tag: z.string(),         // "T{n}",落盘文件名
  goal: z.string(),        // 此刻的任务目标(来自 session)
  plan: z.string(),        // 怎么达成
  direction: z.string(),   // 打算尝试的下一个方向
  status: TraitNodeStatus,
  summary: z.string().default(''),  // 到这个节点为止建立的现状
  keywords: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type TraitNode = z.infer<typeof TraitNode>;

/** 边 —— 一次实际尝试 */
export const TraitEdge = z.object({
  id: z.string(),          // "T{n}"(step 号)
  from: z.string(),        // 出发节点 id
  to: z.string(),          // 结果节点 id
  action: z.string(),      // 做了什么
  result: z.string(),      // 得到什么结果
  outcome: z.enum(['success', 'failed']),
  dead: z.boolean().default(false),  // 折返后标 true
  createdAt: z.string(),
});
export type TraitEdge = z.infer<typeof TraitEdge>;

/** graph.json —— 合并后的当前图(从 T 文件重建的读取缓存) */
export const GraphState = z.object({
  nodes: z.record(z.string(), TraitNode),
  edges: z.record(z.string(), TraitEdge),
  frontier: z.array(z.string()),   // 当前可续接的节点 id(分支时 >1)
});
export type GraphState = z.infer<typeof GraphState>;

/** traitraw/T{n}.json —— 一步审计记录:一个新节点 + 它的入边(plan 无入边) */
export const TraitStep = z.object({
  tag: z.string(),             // "T{n}"
  node: TraitNode,
  edge: TraitEdge.nullable(),  // plan 时为 null;step 为入边;backtrack 为被标死的边
  kind: z.enum(['plan', 'step', 'backtrack']),
  // —— backtrack 专属(重放时恢复 frontier 用) ——
  edgeId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type TraitStep = z.infer<typeof TraitStep>;
