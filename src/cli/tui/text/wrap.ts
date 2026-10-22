/**
 * 折行工具 — 只做折行与行数，不做截断。
 * 使用与 Ink 相同的 wrap-ansi 配置，保证光标与渲染一致。
 */
import wrapAnsi from 'wrap-ansi';
import { displayWidth } from './width.js';

export const WRAP_OPTIONS = { trim: false, hard: true } as const;

const CACHE_LIMIT = 32;
const cache = new Map<string, string[]>();

export function wrapLines(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const key = `${safeWidth}\u0000${text}`;
  const hit = cache.get(key);
  if (hit) {
    // LRU：命中后移到队尾
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const lines = wrapAnsi(text, safeWidth, WRAP_OPTIONS).split('\n');
  cache.set(key, lines);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return lines;
}

/** 光标在折行后的行/列（0 起） */
export function cursorLineColumn(value: string, cursor: number, width: number): { line: number; col: number } {
  const prefix = value.slice(0, cursor);
  const lines = wrapLines(prefix, width);
  return {
    line: lines.length - 1,
    col: displayWidth(lines[lines.length - 1] ?? ''),
  };
}
