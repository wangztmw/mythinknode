/**
 * InferMemStore —— 单 corpus 的知识 DAG 存储(决策修正:按书/按次 ingest 独立,不全局合并)。
 *
 * 一个 corpus = 一次 ingest(一本书,或一次性读的一批书),有独立的 atoms/edges/index。
 * 跨 corpus 合并只在显式 merge 时发生(见 merge.ts)。
 *
 * 布局(~/.mythinknode/infermem/):
 *   corpus.json                      全局注册表:corpusId → CorpusMeta
 *   <corpusId>/
 *     atoms.jsonl                    该 corpus 的知识原子
 *     edges.jsonl                    关系边
 *     index.json                     identityKey → atomId(合并索引,scope 到 corpus)
 *     sources/<docId>/content.json   原文段数组(provenance 指向这里)
 *
 * 变更策略:内存 Map 为准,脏标记后由 flush() 落盘(批处理避免 O(n²) 重写)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { KnowledgeAtom, ExtractedAtom, Edge, Provenance } from './schema.js';
import { buildIdentityKey, deriveAtomId, deriveEdgeId } from './identity.js';

// 可用 INFERMEM_BASE 覆盖(测试用独立路径,避免 rm -rf 碰真实数据)
const BASE = process.env.INFERMEM_BASE || join(homedir(), '.mythinknode', 'infermem');
const CORPUS_JSON = () => join(BASE, 'corpus.json');

export type CorpusStatus = 'extracting' | 'done' | 'failed';

export interface CorpusMeta {
  corpusId: string;
  title: string;
  docIds: string[];
  status: CorpusStatus;
  atomCount: number;
  edgeCount: number;
  updatedAt: string;
}

function now(): string { return new Date().toISOString(); }

function readJson<T>(p: string, fallback: T): T {
  try { return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8')) as T) : fallback; }
  catch { return fallback; }
}

function writeJson(p: string, data: unknown): void {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
}

function readJsonl<T>(p: string): T[] {
  try {
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
  } catch { return []; }
}

export class InferMemStore {
  private atoms = new Map<string, KnowledgeAtom>();  // id → atom
  private edges = new Map<string, Edge>();           // id → edge
  private byKey = new Map<string, string>();         // identityKey → id
  private dirty = false;

  constructor(readonly corpusId: string) { this._load(); }

  private dir() { return join(BASE, this.corpusId); }
  private indexP() { return join(this.dir(), 'index.json'); }
  private atomsP() { return join(this.dir(), 'atoms.jsonl'); }
  private edgesP() { return join(this.dir(), 'edges.jsonl'); }
  private contentP(docId: string) { return join(this.dir(), 'sources', docId, 'content.json'); }

  private _load(): void {
    const idx = readJson<Record<string, string>>(this.indexP(), {});
    this.atoms = new Map(readJsonl<KnowledgeAtom>(this.atomsP()).map(a => [a.id, a]));
    this.edges = new Map(readJsonl<Edge>(this.edgesP()).map(e => [e.id, e]));
    this.byKey = new Map(Object.entries(idx));
  }

  // ---- 内容(决策 #2:原文数组,per-doc) ----

  writeContent(docId: string, segments: string[]): void {
    writeJson(this.contentP(docId), segments);
  }

  readContent(docId: string): string[] {
    return readJson<string[]>(this.contentP(docId), []);
  }

  readSegment(docId: string, segIndex: number): string | null {
    return this.readContent(docId)[segIndex] ?? null;
  }

  /** 按 provenance 取原文片段(渲染证据用) */
  readSpan(p: Provenance, len = 200): string {
    const seg = this.readSegment(p.docId, p.segIndex);
    return seg ? seg.slice(p.offset, p.offset + len) : '';
  }

  // ---- 原子(合并) ----

  getAtom(id: string): KnowledgeAtom | null { return this.atoms.get(id) ?? null; }

  getAtomByIdentityKey(key: string): KnowledgeAtom | null {
    const id = this.byKey.get(key);
    return id ? (this.atoms.get(id) ?? null) : null;
  }

  /**
   * 同 corpus 内的合并:同 identityKey → 合并(别名/provenance/keywords 并集,保留更高 confidence 的 statement)。
   * case 永不合并(其 identityKey 已含内容哈希)。
   */
  putAtom(extracted: ExtractedAtom, prov: Provenance): { atomId: string; merged: boolean; atom: KnowledgeAtom } {
    const key = buildIdentityKey(extracted.kind, extracted.scope, extracted.title, extracted.statement);
    const existing = this.getAtomByIdentityKey(key);

    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...extracted.aliases])];
      existing.keywords = [...new Set([...existing.keywords, ...extracted.keywords])];
      existing.provenance.push(prov);
      if (extracted.confidence > existing.confidence) {
        existing.confidence = extracted.confidence;
        existing.statement = extracted.statement;
      }
      existing.updatedAt = now();
      this.atoms.set(existing.id, existing);
      this.dirty = true;
      return { atomId: existing.id, merged: true, atom: existing };
    }

    const id = deriveAtomId(key);
    const atom: KnowledgeAtom = {
      ...extracted,
      id,
      identityKey: key,
      provenance: [prov],
      createdAt: now(),
      updatedAt: now(),
    };
    this.atoms.set(id, atom);
    this.byKey.set(key, id);
    this.dirty = true;
    return { atomId: id, merged: false, atom };
  }

  /**
   * 跨 corpus 合并用:把另一个 corpus 的完整原子导入本 corpus。
   * 按 identityKey 精确合并(同概念 → 同 id,因为 id 由 identityKey 派生,天然一致)。
   */
  importAtom(atom: KnowledgeAtom): boolean {
    const existing = this.getAtomByIdentityKey(atom.identityKey);
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...atom.aliases, atom.title])];
      existing.keywords = [...new Set([...existing.keywords, ...atom.keywords])];
      existing.provenance.push(...atom.provenance);
      if (atom.confidence > existing.confidence) {
        existing.confidence = atom.confidence;
        existing.statement = atom.statement;
      }
      existing.updatedAt = now();
      this.atoms.set(existing.id, existing);
      this.dirty = true;
      return false;
    }
    this.atoms.set(atom.id, atom);
    this.byKey.set(atom.identityKey, atom.id);
    this.dirty = true;
    return true;
  }

  /**
   * 语义实体消解的核心原语:把 dropId 合并进 keepId(同概念不同名)。
   * 别名/provenance/keywords 并集;边重连到 keep 并重算 id 去重;drop 的 identityKey 重指到 keep。
   */
  mergeAtoms(keepId: string, dropId: string): boolean {
    const keep = this.atoms.get(keepId);
    const drop = this.atoms.get(dropId);
    if (!keep || !drop || keepId === dropId) return false;

    keep.aliases = [...new Set([...keep.aliases, ...drop.aliases, drop.title])];
    keep.keywords = [...new Set([...keep.keywords, ...drop.keywords])];
    keep.provenance.push(...drop.provenance);
    if (drop.confidence > keep.confidence) {
      keep.confidence = drop.confidence;
      keep.statement = drop.statement;
    }
    keep.updatedAt = now();
    this.atoms.set(keepId, keep);

    const dedup = new Map<string, Edge>();
    for (const e of this.edges.values()) {
      if (e.from === dropId) e.from = keepId;
      if (e.to === dropId) e.to = keepId;
      if (e.from === e.to) continue;           // 合并产生的自环 → 丢弃
      e.id = deriveEdgeId(e.from, e.relation, e.to);
      dedup.set(e.id, e);
    }
    this.edges = dedup;

    this.byKey.set(drop.identityKey, keepId);
    this.atoms.delete(dropId);
    this.dirty = true;
    return true;
  }

  // ---- 边(环检测 + 幂等) ----

  getEdge(id: string): Edge | null { return this.edges.get(id) ?? null; }
  listEdges(): Edge[] { return [...this.edges.values()]; }

  putEdge(
    from: string, to: string, relation: Edge['relation'],
    evidence: string, confidence: number, source: Edge['source'],
  ): { edgeId: string; inserted: boolean; cycle: boolean } {
    if (!this.atoms.has(from) || !this.atoms.has(to)) {
      return { edgeId: '', inserted: false, cycle: false };
    }
    const id = deriveEdgeId(from, relation, to);
    if (this.edges.has(id)) return { edgeId: id, inserted: false, cycle: false };

    if (this._wouldCreateCycle(from, to)) {
      return { edgeId: '', inserted: false, cycle: true };
    }

    const edge: Edge = { id, from, to, relation, evidence, confidence, source };
    this.edges.set(id, edge);
    this.dirty = true;
    return { edgeId: id, inserted: true, cycle: false };
  }

  /** 加边 from→to 是否成环:to 是否已能沿边到达 from */
  private _wouldCreateCycle(from: string, to: string): boolean {
    if (from === to) return true;
    const stack = [to];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === from) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of this.edges.values()) {
        if (e.from === cur) stack.push(e.to);
      }
    }
    return false;
  }

  // ---- 查询 ----

  neighbors(id: string): { incoming: Edge[]; outgoing: Edge[] } {
    return {
      incoming: [...this.edges.values()].filter(e => e.to === id),
      outgoing: [...this.edges.values()].filter(e => e.from === id),
    };
  }

  /** 依赖方向拓扑序(学习顺序 + 全图环检测)。有环返回 null。 */
  topoOrder(): string[] | null {
    const indeg = new Map<string, number>();
    for (const a of this.atoms.keys()) indeg.set(a, 0);
    const adj = new Map<string, string[]>();
    for (const e of this.edges.values()) {
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from)!.push(e.to);
    }
    const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const order: string[] = [];
    while (queue.length) {
      const cur = queue.shift()!;
      order.push(cur);
      for (const nxt of adj.get(cur) ?? []) {
        const d = (indeg.get(nxt) ?? 1) - 1;
        indeg.set(nxt, d);
        if (d === 0) queue.push(nxt);
      }
    }
    return order.length === this.atoms.size ? order : null;
  }

  // ---- 统计 / 落盘 ----

  countAtoms(): number { return this.atoms.size; }
  countEdges(): number { return this.edges.size; }
  listAtoms(): KnowledgeAtom[] { return [...this.atoms.values()]; }

  flush(): void {
    if (!this.dirty) return;
    mkdirSync(this.dir(), { recursive: true });
    writeJson(this.indexP(), Object.fromEntries(this.byKey));
    writeFileSync(this.atomsP(), [...this.atoms.values()].map(a => JSON.stringify(a)).join('\n'));
    writeFileSync(this.edgesP(), [...this.edges.values()].map(e => JSON.stringify(e)).join('\n'));
    this.dirty = false;
  }
}

// ---- per-corpus 实例注册表 ----

const _stores = new Map<string, InferMemStore>();

export function getStore(corpusId: string): InferMemStore {
  if (!_stores.has(corpusId)) _stores.set(corpusId, new InferMemStore(corpusId));
  return _stores.get(corpusId)!;
}

export function _resetStores(): void { _stores.clear(); }

// ---- 全局 corpus 注册表(corpus.json) ----

function loadCorpusJson(): Record<string, CorpusMeta> {
  return readJson<Record<string, CorpusMeta>>(CORPUS_JSON(), {});
}

export function listCorpora(): CorpusMeta[] {
  return Object.values(loadCorpusJson()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getCorpus(corpusId: string): CorpusMeta | null {
  return loadCorpusJson()[corpusId] ?? null;
}

export function upsertCorpus(meta: CorpusMeta): void {
  const all = loadCorpusJson();
  all[meta.corpusId] = { ...meta, updatedAt: now() };
  writeJson(CORPUS_JSON(), all);
}

export function removeCorpus(corpusId: string): void {
  const all = loadCorpusJson();
  delete all[corpusId];
  writeJson(CORPUS_JSON(), all);
}
