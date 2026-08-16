/**
 * 输入缓冲 — 自建行编辑器（模式无关）：raw mode + 自管 stdin + bracketed paste + 光标编辑 + 折行 echo。
 * 状态机在 input-model.ts（纯逻辑）；本文件只负责 I/O 驱动 + 渲染（经 ScreenStateLike）。
 *
 * 模式特有行为（滚动键、追加 echo、退出清理）通过 InputDriver 注入，本文件不感知具体模式，
 * 让备用屏/主屏可以独立设计、独立解决问题。
 */
import { createModel, applyChunk } from './input-model.js';
import type { ScreenStateLike, InputDriver } from '../render/types.js';

export function createInputBuffer(ss: ScreenStateLike, driver: InputDriver) {
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

  /** 重绘整块（编辑操作：方向键/退格/中间插入）—— 两个模式都用 rewriteInput。 */
  const redraw = () => {
    const { line, col } = ss.cursorPos(model.chars, model.cursor);
    ss.rewriteInput(ss.foldInput(model.chars), ss.contentLines(model.chars), line, col);
  };

  process.stdin.on('data', (chunk: string) => {
    if (closed) return;

    // 模式特有：滚动键等消费 chunk（备用屏自实现 scrollback）
    if (driver.consumeChunk?.(chunk)) return;

    const oldCursor = model.cursor;
    const effect = applyChunk(model, chunk);

    if (effect.exit) {
      driver.cleanup?.();
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

    if (effect.edit === 'append') {
      driver.append(model.chars, oldCursor);
    } else if (effect.edit === 'redraw') {
      redraw();
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
      // 模式特有清理（备用屏恢复主屏）+ 关闭 bracketed paste + 恢复 raw mode
      driver.cleanup?.();
      ss.emit('\x1b[?2004l');
      if (typeof process.stdin.setRawMode === 'function') {
        try { process.stdin.setRawMode(false); } catch { /* 忽略 */ }
      }
      ss.emit('Bye.\n');
      process.exit(0);
    },
  };
}
