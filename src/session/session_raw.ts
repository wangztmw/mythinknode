/**
 * session_raw — 全量原文存盘 + 关键词索引存盘。
 * 每轮 Query 循环的原始 delta 存为独立 JSON。
 *
 * 原文: ~/.mythinknode/sessions/{id}/raws/{tag}.json
 * 索引: ~/.mythinknode/sessions/{id}/keyword.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SESSIONS_DIR = join(homedir(), '.mythinknode', 'sessions');
const sessionDir = (sessionId: string) => join(SESSIONS_DIR, sessionId);
const rawsDir = (sessionId: string) => join(sessionDir(sessionId), 'raws');
const keywordPath = (sessionId: string) => join(sessionDir(sessionId), 'keyword.json');

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
