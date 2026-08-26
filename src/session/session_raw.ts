/**
 * session_raw — 全量原文存盘 + 关键词索引存盘。
 * 每轮 Query 循环的原始 delta 存为独立 JSON。
 *
 * 原文: ~/.mythinknode/sessions/{id}/raws/{tag}.json
 * 索引: ~/.mythinknode/sessions/{id}/keyword.json
 *
 * 思考轨迹(traitgraph): ~/.mythinknode/sessions/{id}/traitraw/{tag}.json
 * 轨迹索引:            ~/.mythinknode/sessions/{id}/trait-index.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SESSIONS_DIR = join(homedir(), '.mythinknode', 'sessions');
const sessionDir = (sessionId: string) => join(SESSIONS_DIR, sessionId);
const rawsDir = (sessionId: string) => join(sessionDir(sessionId), 'raws');
const keywordPath = (sessionId: string) => join(sessionDir(sessionId), 'keyword.json');
const traitDir = (sessionId: string) => join(sessionDir(sessionId), 'traitraw');
const traitIndexPath = (sessionId: string) => join(sessionDir(sessionId), 'trait-index.json');

export function saveRaw(sessionId: string, tag: string, messages: unknown[]): string {
  const dir = rawsDir(sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${tag}.json`);
  writeFileSync(path, JSON.stringify(messages, null, 2));
  return path;
}

export function loadRaw(sessionId: string, tag: string): unknown[] {
  try {
    const path = join(rawsDir(sessionId), `${tag}.json`);
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return []; }
}

/** 关键词索引存盘：tag -> keywords[] */
export function saveKeywords(sessionId: string, index: Record<string, string[]>): string {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = keywordPath(sessionId);
  writeFileSync(path, JSON.stringify(index, null, 2));
  return path;
}

/** 读关键词索引，失败返回空表 */
export function loadKeywords(sessionId: string): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(keywordPath(sessionId), 'utf-8'));
  } catch { return {}; }
}

/** 探测 raws/ 里已存在的最大 S{n} 序号，供压缩器恢复 counter（防止覆盖旧块） */
export function detectMaxTag(sessionId: string): number {
  try {
    const dir = rawsDir(sessionId);
    if (!existsSync(dir)) return 0;
    let max = 0;
    for (const f of readdirSync(dir)) {
      const m = f.match(/^S(\d+)\.json$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max;
  } catch { return 0; }
}

// ---- traitgraph 思考轨迹存盘（会话级，与 raws 平级） ----

/** 存一步轨迹记录：traitraw/{tag}.json */
export function saveTraitStep(sessionId: string, tag: string, step: unknown): string {
  const dir = traitDir(sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${tag}.json`);
  writeFileSync(path, JSON.stringify(step, null, 2));
  return path;
}

/** 读一步轨迹记录，失败返回 null */
export function loadTraitStep(sessionId: string, tag: string): unknown {
  try {
    const path = join(traitDir(sessionId), `${tag}.json`);
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

/** 列出 traitraw/ 里所有已存在的 T{n} 序号（升序） */
export function listTraitTags(sessionId: string): string[] {
  try {
    const dir = traitDir(sessionId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map(f => f.match(/^T(\d+)\.json$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .sort((a, b) => parseInt(a[1], 10) - parseInt(b[1], 10))
      .map(m => `T${m[1]}`);
  } catch { return []; }
}

/** 探测 traitraw/ 里已存在的最大 T{n} 序号，恢复会话时恢复 counter */
export function detectMaxTraitTag(sessionId: string): number {
  const tags = listTraitTags(sessionId);
  if (tags.length === 0) return 0;
  const last = tags[tags.length - 1];
  return parseInt(last.replace(/^T/, ''), 10) || 0;
}

/** 轨迹关键词索引存盘：tag -> keywords[]（对齐 keyword.json，键用 T{n}） */
export function saveTraitIndex(sessionId: string, index: Record<string, string[]>): string {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = traitIndexPath(sessionId);
  writeFileSync(path, JSON.stringify(index, null, 2));
  return path;
}

/** 读轨迹关键词索引，失败返回空表 */
export function loadTraitIndex(sessionId: string): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(traitIndexPath(sessionId), 'utf-8'));
  } catch { return {}; }
}
