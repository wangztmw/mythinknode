/**
 * TraitGraphStore —— 会话级「思维-执行」轨迹图的数据层。
 *
 * 每个会话一个 store,维护一张有向图:
 *   节点 = 思维状态(goal/plan/direction)
 *   边   = 一次尝试(action/result/outcome)
 *   前沿 = 当前唯一活跃节点(折返时回退)
 *
 * 落盘三样(都在会话目录内,与 raws/ 平级):
 *   traitraw/T{n}.json    一步审计记录(plan/step/backtrack),线性追加
 *   graph.json            合并后的当前图(读取缓存)
 *   trait-index.json      T{n} -> 关键词(Session Memory 的 T 标记索引)
 *
 * 变更策略:内存 GraphState 为准,每次写同步追加 T 文件 + 重写 graph.json + 重写索引。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TraitNode, TraitEdge, TraitStep } from './schema.js';
import {
  saveTraitStep, listTraitTags, loadTraitIndex,
  saveTraitIndex, loadTraitStep,
} from '../session/session_raw.js';

const SESSIONS_DIR = join(homedir(), '.mythinknode', 'sessions');

function now(): string { return new Date().toISOString(); }

function edgeId(from: string, to: string): string { return `${from}>${to}`; }

export interface PlanInput {
  goal: string;
  plan: string;
  direction: string;
  summary?: string;
  keywords?: string[];
}

export interface StepInput {
  action: string;
  result: string;
  outcome: 'success' | 'failed';
  goal?: string;
  plan?: string;
  direction?: string;
  summary?: string;
  keywords?: string[];
  from?: string;   // 缺省 = 当前 frontier
}

export class TraitGraphStore {
  private nodes = new Map<string, TraitNode>();
  private edges = new Map<string, TraitEdge>();
  private frontier: string | null = null;
  private counter = 0;

  constructor(readonly sessionId: string) {
    this._load();
  }

  // ---- 路径 ----

  private graphP(): string { return join(SESSIONS_DIR, this.sessionId, 'graph.json'); }

  // ---- 加载(从 T 文件重放,恢复 counter + frontier) ----

  private _load(): void {
    const tags = listTraitTags(this.sessionId);
    let frontier: string | null = null;

    for (const tag of tags) {
      const n = parseInt(tag.replace(/^T/, ''), 10);
      if (n > this.counter) this.counter = n;
      const step = loadTraitStep(this.sessionId, tag) as TraitStep | null;
      if (!step) continue;

      if (step.kind === 'plan') {
        this.nodes.set(step.node.id, step.node);
        frontier = step.node.id;
      } else if (step.kind === 'step') {
        this.nodes.set(step.node.id, step.node);
        if (step.edge) {
          this.edges.set(step.edge.id, step.edge);
          // 新节点入链时,把旧 frontier 标记为已走过(除非它本就是锚点)
          const prev = frontier;
          if (prev) {
            const p = this.nodes.get(prev);
            if (p && p.status === 'active') p.status = 'done';
          }
        }
        frontier = step.node.id;
      } else if (step.kind === 'backtrack') {
        // 标记折返边为死路,frontier 回退
        if (step.edgeId) {
          const e = this.edges.get(step.edgeId);
          if (e) e.dead = true;
        }
        if (step.from) {
          const f = this.nodes.get(step.from);
          if (f && f.status === 'active') f.status = 'failed';
        }
        frontier = step.to ?? null;
      }
    }

    this.frontier = frontier;
  }

  // ---- 写原语 ----

  private _writeStep(step: TraitStep): void {
    saveTraitStep(this.sessionId, step.tag, step);
    this._saveGraph();
    this._saveIndex();
  }

  private _saveGraph(): void {
    const p = this.graphP();
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify({
      nodes: Object.fromEntries(this.nodes),
      edges: Object.fromEntries(this.edges),
      frontier: this.frontier ? [this.frontier] : [],
    }, null, 2));
  }

  private _saveIndex(): void {
    const idx: Record<string, string[]> = {};
    for (const n of this.nodes.values()) {
      if (n.keywords.length > 0) idx[n.tag] = n.keywords;
    }
    saveTraitIndex(this.sessionId, idx);
  }

  private _nextTag(): string {
    return `T${++this.counter}`;
  }

  // ---- 公开操作 ----

  /** 开新目标:建根/分支节点,设为 frontier */
  plan(input: PlanInput): TraitNode {
    const tag = this._nextTag();
    const node: TraitNode = {
      id: tag,
      tag,
      goal: input.goal,
      plan: input.plan,
      direction: input.direction,
      status: 'active',
      summary: input.summary ?? '',
      keywords: input.keywords ?? [],
      createdAt: now(),
    };
    this.nodes.set(node.id, node);
    this.frontier = node.id;
    this._writeStep({ tag, node, edge: null, kind: 'plan' });
    return node;
  }

  /** 记一次尝试:从 from(默认 frontier)出发,建新现状节点 + 入边 */
  step(input: StepInput): { node: TraitNode; edge: TraitEdge } {
    const from = input.from ?? this.frontier;
    if (!from || !this.nodes.has(from)) {
      throw new Error(`no frontier to step from (from="${from ?? ''}" not found). Call plan() first.`);
    }
    const tag = this._nextTag();
    const node: TraitNode = {
      id: tag,
      tag,
      goal: input.goal ?? this.nodes.get(from)!.goal,
      plan: input.plan ?? '',
      direction: input.direction ?? '',
      status: 'active',
      summary: input.summary ?? '',
      keywords: input.keywords ?? [],
      createdAt: now(),
    };
    const edge: TraitEdge = {
      id: edgeId(from, node.id),
      from,
      to: node.id,
      action: input.action,
      result: input.result,
      outcome: input.outcome,
      dead: false,
      createdAt: now(),
    };
    this.nodes.set(node.id, node);
    this.edges.set(edge.id, edge);
    // 出发节点不再活跃(已走过),新节点成为 frontier
    const fromNode = this.nodes.get(from);
    if (fromNode && fromNode.status === 'active') fromNode.status = 'done';
    this.frontier = node.id;
    this._writeStep({ tag, node, edge, kind: 'step' });
    return { node, edge };
  }

  /** 折返:当前 frontier 走不通 → 标死入边,frontier 回退到 to */
  backtrack(to: string, from?: string): TraitEdge | null {
    const cur = from ?? this.frontier;
    if (!cur) throw new Error('no frontier to backtrack from.');
    if (!this.nodes.has(to)) throw new Error(`backtrack target "${to}" not found.`);

    // 找 cur 的入边标死
    let marked: TraitEdge | null = null;
    for (const e of this.edges.values()) {
      if (e.to === cur) {
        e.dead = true;
        marked = e;
      }
    }
    const curNode = this.nodes.get(cur);
    if (curNode && curNode.status === 'active') curNode.status = 'failed';

    const toNode = this.nodes.get(to);
    if (toNode && toNode.status === 'failed') toNode.status = 'active';

    this.frontier = to;

    // T 文件记录「被放弃的节点 + 被标死的边」(不造合成节点)
    const tag = this._nextTag();
    const step: TraitStep = {
      tag,
      node: curNode ?? { id: cur, tag: cur, goal: '', plan: '', direction: '', status: 'failed', summary: '', keywords: [], createdAt: now() },
      edge: marked,
      kind: 'backtrack',
      edgeId: marked?.id ?? undefined,
      from: cur,
      to,
    };
    this._writeStep(step);
    return marked;
  }

  // ---- 读 ----

  getNode(id: string): TraitNode | null { return this.nodes.get(id) ?? null; }
  getEdge(id: string): TraitEdge | null { return this.edges.get(id) ?? null; }
  getFrontier(): TraitNode | null { return this.frontier ? (this.nodes.get(this.frontier) ?? null) : null; }
  listNodes(): TraitNode[] { return [...this.nodes.values()]; }
  listEdges(): TraitEdge[] { return [...this.edges.values()]; }

  /** 从 root 沿未死边走到当前 frontier 的主路径(用于 status) */
  pathToFrontier(): TraitNode[] {
    if (!this.frontier) return [];
    const path: TraitNode[] = [];
    const byTo = new Map<string, TraitEdge>();
    for (const e of this.edges.values()) {
      if (!e.dead && !byTo.has(e.to)) byTo.set(e.to, e);
    }
    let cur: string | null = this.frontier;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const node = this.nodes.get(cur);
      if (node) path.unshift(node);
      const e = byTo.get(cur);
      cur = e ? e.from : null;
    }
    return path;
  }
}

// ---- per-session 实例注册表 ----

const _stores = new Map<string, TraitGraphStore>();

export function getTraitGraphStore(sessionId: string): TraitGraphStore {
  if (!_stores.has(sessionId)) _stores.set(sessionId, new TraitGraphStore(sessionId));
  return _stores.get(sessionId)!;
}

export function _resetTraitGraphStores(): void { _stores.clear(); }

// 保持 loadTraitIndex 的 re-export 便于 recall 使用(语义上属于 session 层)
export { loadTraitIndex, loadTraitStep };
