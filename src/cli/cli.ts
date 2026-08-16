/**
 * CLI — 接线层：按终端类型选择渲染模式，组装输入缓冲 + 渲染器。
 *
 * 终端选择：
 *   - iTerm2（TERM_PROGRAM=iTerm.app）→ 主屏（原生滚动 + 滚动条，iTerm2 无 nano 崩溃）
 *   - Mac 原生 Terminal 等其他 → 备用屏（grid + cell-diff 光标重绘，避开 nano 崩溃）
 *
 * 两个模式完全解耦：各自的 ScreenState + 输入驱动（driver）独立成模块，
 * 本文件只做选择 + 接线，不混入模式逻辑。
 */
import { C, B, b, c } from './render/ansi.js';
import { ScreenState, createAltDriver } from './render/screen-state.js';
import { MainScreenState, createMainDriver } from './render/screen-state-main.js';
import { HybridScreenState, createHybridDriver } from './render/screen-state-hybrid.js';
import type { ScreenStateLike, InputDriver } from './render/types.js';
import { createRenderer } from './render/renderer.js';
import { createInputBuffer } from './input/input-buffer.js';

export function createCLI() {
  const PROMPT = `${C}${B}mythinknode${b}${c} ${B}>>>${b} `;
  const isITerm2 = process.env.TERM_PROGRAM === 'iTerm.app';
  // 渲染模式：MYTHINKNODE_MODE 显式覆盖（hybrid|main|alt），否则按终端类型
  //   iTerm2 → main（原生滚动 + 滚动条，无 nano 崩溃）；其他 → alt（备用屏网格，避开崩溃）
  const mode = process.env.MYTHINKNODE_MODE ?? (isITerm2 ? 'main' : 'alt');

  let ss: ScreenStateLike;
  let driver: InputDriver;
  if (mode === 'hybrid') {
    // 混合模式：主屏原生滚动条 + cell-diff 活区 + \n 提交溢出进原生 scrollback（实验）
    const hybrid = new HybridScreenState(PROMPT);
    process.stdout.on('resize', () => hybrid.onResize());
    ss = hybrid;
    driver = createHybridDriver(hybrid);
  } else if (mode === 'main') {
    const main = new MainScreenState(PROMPT);
    ss = main;
    driver = createMainDriver(main);
  } else {
    const alt = new ScreenState(PROMPT);
    alt.enterAltScreen();
    // 终端尺寸变化：网格跟随重绘（否则旧尺寸的网格会错位/留空白）
    process.stdout.on('resize', () => alt.onResize());
    ss = alt;
    driver = createAltDriver(alt);
  }

  const input = createInputBuffer(ss, driver);
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
