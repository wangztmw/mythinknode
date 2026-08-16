/**
 * CLI — 接线层：按终端类型选择渲染模式，组装输入缓冲 + 渲染器。
 *
 * 终端选择：
 *   - iTerm2（TERM_PROGRAM=iTerm.app）→ 主屏（原生滚动 + 滚动条，iTerm2 无 nano 崩溃）
 *   - Mac 原生 Terminal 等其他 → 备用屏（grid + cell-diff 光标重绘，避开 nano 崩溃）
 */
import { C, B, b, c } from './render/ansi.js';
import { ScreenState } from './render/screen-state.js';
import { MainScreenState } from './render/screen-state-main.js';
import type { AnyScreenState } from './render/renderer.js';
import { createRenderer } from './render/renderer.js';
import { createInputBuffer } from './input/input-buffer.js';
import type { ScreenMode } from './input/input-buffer.js';

export function createCLI() {
  const PROMPT = `${C}${B}mythinknode${b}${c} ${B}>>>${b} `;
  // iTerm2 → 主屏（原生滚动）；Mac 原生 Terminal 等 → 备用屏（grid，避免 nano 崩溃）。
  const mode: ScreenMode = process.env.TERM_PROGRAM === 'iTerm.app' ? 'main' : 'alt';
  const ss: AnyScreenState = mode === 'main' ? new MainScreenState(PROMPT) : new ScreenState(PROMPT);

  if (mode === 'alt') {
    (ss as ScreenState).enterAltScreen();
    // 终端尺寸变化：网格跟随重绘（否则旧尺寸的网格会错位/留空白）
    process.stdout.on('resize', () => (ss as ScreenState).onResize());
  }

  const input = createInputBuffer(ss, mode);
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
