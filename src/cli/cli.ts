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
  // 进入备用屏：grid 光标重绘 = 固定屏幕语义，且避开 Terminal.app 原生滚动（崩溃源）。
  // close() / Ctrl+C 里 leaveAltScreen() 恢复主屏。
  ss.enterAltScreen();
  // 终端尺寸变化：网格跟随重绘（否则旧尺寸的网格会错位/留空白）
  process.stdout.on('resize', () => ss.onResize());
  const input = createInputBuffer(ss);
  const renderer = createRenderer(ss);

  return {
    setBusy: input.setBusy,
    readLine: input.readLine,
    renderResult: renderer.renderResult,
    renderError: renderer.renderError,
    startRender: renderer.startRender,
    showHelp: renderer.showHelp,
    // 备用屏启动后，banner 也要进 grid（否则 console.log 写主屏会被隐藏）
    writeLines: (text: string) => ss.writeLines(text),
    close: input.close,
  };
}
