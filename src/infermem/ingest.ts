/**
 * ingest —— 后台编排任务:markdown → 切段 → 逐段抽取(增量落盘)→ 归并 → 语义消解 → 隐式推断。
 *
 * 决策修正:按 corpus 独立成图。一个 corpus = 一次 ingest(一本书或一次性读的一批书)。
 * 同 corpus 内 identityKey 合并;跨 corpus 不合并,除非显式 merge(见 merge.ts)。
 *
 * 关键设计(修「llm 并发」根因):
 *   - startIngest 立即返回 jobId,不在工具调用里同步跑长任务
 *   - 全局防重入 + 逐块增量 flush + 连续失败断路器 + 失败段重试
 */
import type { LLMClient } from '../llm/types.js';
import { chunkMarkdown } from './chunker.js';
import { extractChunk } from './extractor.js';
import { insertAtoms, resolveExactRefs, resolveDanglingRefs, type PendingRef } from './reducer.js';
import { resolveEntities } from './resolve.js';
import { linkImplicit } from './link.js';
import { getStore, getCorpus, upsertCorpus } from './store.js';

// ingest 专用 LLM client(更高并发,不挤主循环的 max=2)。由 Mythinknode.ts 启动时注入。
let _ingestLLM: LLMClient | null = null;
export function setInfermemLLM(llm: LLMClient | null): void { _ingestLLM = llm; }
export function getInfermemLLM(): LLMClient | null { return _ingestLLM; }

const INGEST_CONCURRENCY = 4;   // 抽取并发度(受 ingest client 的 maxConcurrency 约束)
const CIRCUIT_BREAKER = 8;      // 连续失败 ≥8 段 → 判定 API 不可用,中止(避免空转几小时)

export interface IngestInput {
  docId: string;
  title: string;
  sourcePath: string;
  markdown: string;
}

export interface IngestOptions {
  semanticResolve?: boolean;   // 语义实体消解(默认 true)
  semanticRefs?: boolean;      // 悬空引用语义兜底(默认 true)
  implicitLinks?: boolean;     // 隐式边推断(默认 true)
}

export interface IngestJob {
  jobId: string;
  corpusId: string;
  docId: string;
  title: string;
  status: 'running' | 'done' | 'failed';
  segmentsDone: number;
  segmentsTotal: number;
  atoms: number;
  edges: number;
  merged: number;
  inferred: number;
  danglingRefs: number;
  failedSegments: number;
  error?: string;
  startedAt: string;
}

const _jobs = new Map<string, IngestJob>();
let _jobSeq = 0;

export function listIngestJobs(): IngestJob[] { return [..._jobs.values()]; }
export function getIngestJob(jobId: string): IngestJob | null { return _jobs.get(jobId) ?? null; }

function runningJob(): IngestJob | null {
  return [..._jobs.values()].find(j => j.status === 'running') ?? null;
}

/** 启动后台 ingest。全局防重入:已有 job 在跑则拒绝。 */
export function startIngest(
  corpusId: string,
  llm: LLMClient,
  input: IngestInput,
  options: IngestOptions = {},
): { jobId: string; started: boolean } {
  const existing = runningJob();
  if (existing) return { jobId: existing.jobId, started: false };

  const jobId = `ingest-${(++_jobSeq).toString(36)}-${Date.now().toString(36)}`;
  const job: IngestJob = {
    jobId, corpusId, docId: input.docId, title: input.title, status: 'running',
    segmentsDone: 0, segmentsTotal: 0, atoms: 0, edges: 0, merged: 0, inferred: 0, danglingRefs: 0, failedSegments: 0,
    startedAt: new Date().toISOString(),
  };
  _jobs.set(jobId, job);

  void runIngestJob(jobId, corpusId, llm, input, options).catch(e => {
    job.status = 'failed';
    job.error = (e as Error).message;
    console.error('[infermem] ingest crashed:', e);
  });
  return { jobId, started: true };
}

/** 后台执行体(awaitable,测试也直接调它) */
export async function runIngestJob(
  jobId: string,
  corpusId: string,
  llm: LLMClient,
  input: IngestInput,
  options: IngestOptions = {},
): Promise<void> {
  const { semanticResolve = true, semanticRefs = true, implicitLinks = true } = options;
  const store = getStore(corpusId);
  const job = _jobs.get(jobId)!;

  try {
    const segments = chunkMarkdown(input.markdown);
    job.segmentsTotal = segments.length;
    store.writeContent(input.docId, segments);

    // 注册表:union docIds(支持批量 ingest 到同一 corpus)
    const existing = getCorpus(corpusId);
    const docIds = existing ? [...new Set([...existing.docIds, input.docId])] : [input.docId];
    upsertCorpus({
      corpusId, title: input.title, docIds, status: 'extracting',
      atomCount: 0, edgeCount: 0, updatedAt: new Date().toISOString(),
    });
    store.flush();

    // 逐段抽取(有界并发)+ 精确合并 + 增量落盘 + 连续失败断路器
    const pending: PendingRef[] = [];
    const failedIdx: number[] = [];
    let completed = 0;
    let consecutiveFailures = 0;
    for (let i = 0; i < segments.length; i += INGEST_CONCURRENCY) {
      const results = await Promise.all(segments.slice(i, i + INGEST_CONCURRENCY).map((seg, off) => {
        const idx = i + off;
        return extractChunk(llm, seg, {
          prevTitle: segmentHeading(segments[idx - 1]),
          nextTitle: segmentHeading(segments[idx + 1]),
        }).then(r => ({ idx, r }));
      }));

      for (const { idx, r } of results) {
        if (r.atoms.length > 0) {
          pending.push(...insertAtoms(store, [{ docId: input.docId, segIndex: idx, atoms: r.atoms }]));
          consecutiveFailures = 0;
        } else if (r.error) {
          failedIdx.push(idx);        // 失败段,稍后重试
          consecutiveFailures++;
        }
        // error undefined + 0 atoms = 空段,不算失败
        job.segmentsDone = ++completed;
        job.atoms = store.countAtoms();
        job.edges = store.countEdges();
      }
      store.flush();   // 每批落盘,status 可见进度

      if (consecutiveFailures >= CIRCUIT_BREAKER) {
        throw new Error(`连续 ${consecutiveFailures} 段抽取失败(最后: ${results[results.length - 1]?.r?.error ?? '?'}) —— 疑似 API 不可用(余额/网络),已中止。已抽 ${job.atoms} 原子。`);
      }
    }

    // 二次重试:失败段重试一次(瞬态网络抖动)
    for (const idx of failedIdx) {
      const r = await extractChunk(llm, segments[idx], {
        prevTitle: segmentHeading(segments[idx - 1]),
        nextTitle: segmentHeading(segments[idx + 1]),
      });
      if (r.atoms.length > 0) {
        pending.push(...insertAtoms(store, [{ docId: input.docId, segIndex: idx, atoms: r.atoms }]));
      } else {
        job.failedSegments++;
      }
    }
    store.flush();

    // 全量就位后:精确引用 → 语义消解 → 悬空兜底 → 隐式推断
    const dangling = resolveExactRefs(store, pending);

    if (semanticResolve) job.merged = (await resolveEntities(store, llm)).merged;

    let refResolved = 0;
    if (semanticRefs && dangling.length > 0) refResolved = (await resolveDanglingRefs(store, llm, dangling)).resolved;

    if (implicitLinks) job.inferred = (await linkImplicit(store, llm)).added;

    job.danglingRefs = dangling.length - refResolved;
    job.atoms = store.countAtoms();
    job.edges = store.countEdges();

    upsertCorpus({
      corpusId, title: input.title, docIds, status: 'done',
      atomCount: store.countAtoms(), edgeCount: store.countEdges(),
      updatedAt: new Date().toISOString(),
    });
    store.flush(true);   // 强制落盘(即使 dirty 已清除、目录被删也能重建)
    job.status = 'done';
  } catch (e) {
    job.status = 'failed';
    job.error = (e as Error).message;
    store.flush(true);   // 强制落盘已抽到的内容(目录被删也能重建)
    throw e;
  }
}

/** 取一个段的标题(首个 # 行),给相邻段做跨块引用上下文 */
function segmentHeading(seg: string | undefined): string | undefined {
  if (!seg) return undefined;
  const m = seg.match(/^#{1,6}\s+(.+)$/m);
  return m ? m[1].trim() : undefined;
}
