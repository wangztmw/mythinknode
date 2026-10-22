/**
 * TUI 专属限制 — 与旧 UI 完全分开。
 * 语义上限（逻辑行/字符）供生产端使用；可视行上限供 render 层使用。
 */
import type { Breakpoint } from './breakpoints.js';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 输入框可见行数：随终端高度变化，矮屏强制 4 行 */
export function inputLines(rows: number): number {
  if (rows < 18) return 4;
  return clamp(rows - 12, 4, 12);
}

export const THOUGHT_MAX_LINES = 40;
export const THOUGHT_MAX_CHARS = 4000;
export const THOUGHT_VISIBLE_LINES = 8;

export const TOOL_PREVIEW_MAX_LINES = 8;
export const TOOL_PREVIEW_MAX_CHARS = 800;

export function toolVisibleLines(bp: Breakpoint): number {
  return bp.compact ? 4 : 6;
}

export function hintText(bp: Breakpoint): string {
  return bp.narrow
    ? 'Enter 发送 · Ctrl+C 退出'
    : 'Enter 发送 · ↑↓ 历史 · Ctrl+U 清行 · Ctrl+W 删词';
}
