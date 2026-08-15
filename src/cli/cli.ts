/**
 * CLI — 接线层：把输入缓冲（input-buffer）和输出渲染器（renderer）组装成 createCLI。
 *
 * 宽度自适应：
 *   ≥60列 → \r 原地覆写（正常体验）
 *   <60列 → 仅显示首帧+尾帧（防止 \r+ANSI 折行 + 刷屏）
 */
import { createRenderer } from './render/renderer.js';
import { createInputBuffer } from './input/input-buffer.js';

export function createCLI() {
  const input = createInputBuffer();
  const renderer = createRenderer();

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
