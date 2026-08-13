/**
 * raw-storage — 全量原文存盘。每轮 Query 循环的原始 delta 存为独立 JSON。
 *
 * 路径: ~/.mythinknode/sessions/{id}/raws/{tag}.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SESSIONS_DIR = join(homedir(), '.mythinknode', 'sessions');
const rawsDir = (sessionId: string) => join(SESSIONS_DIR, sessionId, 'raws');

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
