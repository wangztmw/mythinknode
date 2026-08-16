/**
 * 输入缓冲 — 自建行编辑器：raw mode + 自管 stdin + bracketed paste + 光标编辑 + 折行 echo。
 * 状态机在 input-model.ts（纯逻辑）；本文件只负责 I/O 驱动 + 渲染（经 ScreenState）。
 *
 * mode：
 *   'alt'（备用屏网格）：滚动键（PgUp/PgDn/滚轮）驱动自实现 scrollback，close/Ctrl+C 恢复主屏，
 *                       追加走 grid redraw（diff 只写变化 cell）。
 *   'main'（主屏原生滚动）：无滚动键、无备用屏，追加走 O(1) appendInput（只写新字符）。
 */
import { createModel, applyChunk } from './input-model.js';
import type { ScreenState } from '../render/screen-state.js';
import type { MainScreenState } from '../render/screen-state-main.js';

export type ScreenMode = 'alt' | 'main';

export function createInputBuffer(ss: ScreenState | MainScreenState, mode: ScreenMode) {
  const isAlt = mode === 'alt';

  let resolveLine: ((value: string) => void) | null = null;
  const model = createModel();
  let closed = false;

  // 进入 raw mode（保 IME composition 状态机）
  if (typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
  }
  process.stdin.setEncoding('utf8');
  // 启用 bracketed paste：让终端用 \x1b[200~ 和 \x1b[201~ 包裹粘贴内容，
  // 从而可靠区分"粘贴内容里的换行"和"用户按的回车提交"。
  ss.emit('\x1b[?2004h');

  /** 重绘整块（可能多行）—— 委托 ScreenState，其内部用 inputRows 上移回输入块第一行 */
  const redraw = () => {
    const { line, col } = ss.cursorPos(model.chars, model.cursor);
    ss.rewriteInput(ss.foldInput(model.chars), ss.contentLines(model.chars), line, col);
  };

  process.stdin.on('data', (chunk: string) => {
    if (closed) return;

    // 自实现 scrollback（仅备用屏）：PgUp/PgDn + 滚轮（替代滚动模式发方向键）滚动输出
    if (isAlt) {
      const alt = ss as ScreenState;
      const page = Math.max(1, alt.rows - 1);
      if (chunk === '\x1b[5~') { alt.scrollBy(page); return; }   // PgUp 向上
      if (chunk === '\x1b[6~') { alt.scrollBy(-page); return; }  // PgDn 向下
      if (chunk === '\x1b[A') { alt.scrollBy(page); return; }    // 滚轮上（替代滚动发 ↑）→ 看更早
      if (chunk === '\x1b[B') { alt.scrollBy(-page); return; }   // 滚轮下（发 ↓）→ 看更近
      // 非滚动输入：若在回滚态，先回到底（打字/编辑/提交都先回到最新输出）
      if (alt.scrolledBack) alt.scrollToBottom();
    }

    const oldCursor = model.cursor;
    const effect = applyChunk(model, chunk);

    if (effect.exit) {
      if (isAlt) (ss as ScreenState).leaveAltScreen();
      ss.emit('\nBye.\n');
      process.exit(0);
      return;
    }

    if (effect.submit != null) {
      const rawText = model.chars.join('');  // 捕获原始输入（清空前），供提交行进历史
      model.chars = [];
      model.cursor = 0;
      if (resolveLine) {
        const resolve = resolveLine;
        resolveLine = null;
        resolve(effect.submit);
      }
      if (effect.newline) ss.submitInput(rawText);
      return;
    }

    if (effect.edit === 'append' || effect.edit === 'redraw') {
      if (!isAlt && effect.edit === 'append') {
        // 主屏：追加 O(1) 折行 echo，只写新 chunk、不触发 \x1b[J、不软折行
        const { col: startCol } = ss.cursorPos(model.chars, oldCursor);
        const newChars = model.chars.slice(oldCursor);
        (ss as MainScreenState).appendInput(ss.foldInput(newChars, startCol), ss.contentLines(model.chars));
      } else {
        // 备用屏：统一全量重绘，grid diff 只写变化 cell
        redraw();
      }
    }
  });

  return {
    setBusy(busy: boolean): void {
      if (busy) {
        process.stdin.pause();
      } else {
        process.stdin.resume();
      }
    },

    readLine(): Promise<string> {
      return new Promise(resolve => {
        resolveLine = resolve;
        model.chars = [];
        model.cursor = 0;
        ss.printPrompt();
      });
    },

    close(): void {
      closed = true;
      // 备用屏恢复主屏 + 关闭 bracketed paste + 恢复 raw mode，避免退出后终端状态残留
      if (isAlt) (ss as ScreenState).leaveAltScreen();
      ss.emit('\x1b[?2004l');
      if (typeof process.stdin.setRawMode === 'function') {
        try { process.stdin.setRawMode(false); } catch { /* 忽略 */ }
      }
      ss.emit('Bye.\n');
      process.exit(0);
    },
  };
}
