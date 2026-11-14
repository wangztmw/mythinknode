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

/** 队列托盘最多显示几条（固定上限，不随终端高度变化，避免矮屏把输入框挤出可视区） */
export const QUEUE_VISIBLE_ITEMS = 3;

/**
 * 底部提示行。
 *
 * `running` 必须换文案：运行中按 Enter 不是「立刻发出去」而是「入队」，
 * 不写清楚用户会以为按键失灵。`queued > 0` 时额外给出清空出口。
 */
export function hintText(bp: Breakpoint, opts: { running: boolean; queued: number }): string {
  const queueHint = opts.queued > 0 ? ` · 队列 ${opts.queued} 条（Ctrl+X 清空）` : '';
  if (bp.narrow) {
    return opts.running ? `Enter 排队${queueHint}` : `Enter 发送${queueHint}`;
  }
  return opts.running
    ? `Enter 排队发送 · Esc 中断 · Ctrl+U 清行${queueHint}`
    : `Enter 发送 · ↑↓ 历史 · Ctrl+U 清行 · Ctrl+W 删词${queueHint}`;
}
