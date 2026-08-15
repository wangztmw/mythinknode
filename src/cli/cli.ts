/**
 * CLI — 接线层：创建 ScreenState（单一屏幕模型），组装输入缓冲 + 渲染器。
 *
 * 宽度自适应：
 *   ≥60列 → \r 原地覆写（正常体验）
 *   <60列 → 仅显示首帧+尾帧（防止 \r+ANSI 折行 + 刷屏）
 */
import { C, B, b, c } from './render/ansi.js';
import { ScreenState } from './render/screen-state.js';
import { createRenderer } from './render/renderer.js';
import { createInputBuffer } from './input/input-buffer.js';

export function createCLI() {
  const PROMPT = `${C}${B}mythinknode${b}${c} ${B}>>>${b} `;
  const ss = new ScreenState(PROMPT);
  const input = createInputBuffer(ss);
  const renderer = createRenderer(ss);

  return {
    setBusy: input.setBusy,
    readLine: input.readLine,
    renderResult: renderer.renderResult,
    renderError: renderer.renderError,
    startRender: renderer.startRender,
    showHelp: renderer.showHelp,
    close: input.close,
  };
}
