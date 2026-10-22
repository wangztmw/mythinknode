/**
 * 输入框几何 — 折行宽度与光标 X 共用同一份计算。
 * 任何 padding/边框变化都必须走这里，禁止在组件里硬编码。
 */
import type { Breakpoint } from './breakpoints.js';
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

export function computeInputGeometry(columns: number, bp: Breakpoint): InputGeometry {
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
    inputY: 2, // marginTop 1 + 上边框 1
  };
}
