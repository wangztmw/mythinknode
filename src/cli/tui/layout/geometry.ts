/**
 * 输入框几何 — 折行宽度与光标 X/Y 共用同一份计算。
 * 任何 padding/边框变化都必须走这里，禁止在组件里硬编码。
 *
 * ⚠️ `inputY` 是从「动态区域」（ink 每帧重绘的那部分）顶行算起的行号，
 * 不是屏幕绝对行。ink 的 `<Static>` 是 `position: absolute`，不参与流，
 * 所以历史日志不计入这个坐标系。
 *
 * 动态区域里 InputBox 上方还可能有别的区块（状态行等）。这些区块的高度
 * 必须由调用方通过 `aboveRows` 传进来 —— 漏算一块，光标就会偏上若干行，
 * 表现为「发消息之后打字，光标不在输入框里」。
 */
import type { Breakpoint } from './breakpoints.js';
import { QUEUE_VISIBLE_ITEMS } from './limits.js';
import { spacing } from '../theme.js';

export interface InputGeometry {
  border: number;
  paddingX: number;
  promptWidth: number;
  textWidth: number;
  inputX: number;
  inputY: number;
}

export const PROMPT_WIDTH = 2; // '› '
export const BORDER_WIDTH = 1;

/**
 * InputBox 自身在其内容行上方占的行数：`marginTop={1}` + 上边框 1 行。
 */
export const INPUT_OWN_ABOVE = 2;

/**
 * 动态区域里可能出现在 InputBox 上方的区块高度。
 *
 * 加新区块时必须在这里登记，并在调用点把它算进 `aboveRows`；
 * 否则光标定位会偏，且**只有该区块可见时才复现**（很容易漏测）。
 */
export const ABOVE_BLOCK_HEIGHTS = {
  /** ThinkingStatus：`marginTop={1}` + 单行状态文本（内部已 truncateToWidth，恒 1 行） */
  status: 2,
} as const;

/**
 * 队列托盘占用的行数 —— **0 表示不渲染**。
 *
 * 组成：1 行 marginTop（与上方区域留白）+ 最多 QUEUE_VISIBLE_ITEMS 条 + 0/1 行「还有 N 条」。
 *
 * ⚠️ 这是托盘「是否渲染」与「占几行」的**唯一来源**。
 *    分别在两处判断（渲染处看 queue.length > 0，高度处看 queue.length）会漂移，
 *    一旦漂移就是光标偏上若干行 —— 与之前 ThinkingStatus 那个 bug 同一类（L26）。
 */
export function queueRows(queueLength: number): number {
  if (queueLength <= 0) return 0;
  const GAP_ROWS = 1;   // marginTop：托盘与上方内容之间留一个空行
  const shown = Math.min(queueLength, QUEUE_VISIBLE_ITEMS);
  const hasMore = queueLength > QUEUE_VISIBLE_ITEMS ? 1 : 0;
  return GAP_ROWS + shown + hasMore;
}

export function computeInputGeometry(
  columns: number,
  bp: Breakpoint,
  aboveRows = 0,
): InputGeometry {
  const paddingX = bp.narrow ? spacing.inputNarrowPaddingX : spacing.inputPaddingX;
  const textWidth = Math.max(
    1,
    columns - 2 * BORDER_WIDTH - 2 * paddingX - PROMPT_WIDTH,
  );

  return {
    border: BORDER_WIDTH,
    paddingX,
    promptWidth: PROMPT_WIDTH,
    textWidth,
    inputX: BORDER_WIDTH + paddingX + PROMPT_WIDTH,
    inputY: aboveRows + INPUT_OWN_ABOVE,
  };
}
