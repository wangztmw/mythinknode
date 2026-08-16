/**
 * 输入缓冲 — 自建行编辑器：raw mode + 自管 stdin + bracketed paste + 光标编辑 + 折行 echo。
 * 状态机在 input-model.ts（纯逻辑）；本文件只负责 I/O 驱动 + 渲染（经 ScreenState）。
 */
import { createModel, applyChunk } from './input-model.js';
import type { ScreenState } from '../render/screen-state.js';

export function createInputBuffer(ss: ScreenState) {
  // 自建内容管理：raw mode + 自管 stdin，彻底绕开 readline。
  //
  // 为什么不用 readline：
  //   - terminal: true  → IME 正常，但超长单行 O(n²) 逐字符回显重绘卡死（实测 5 万字卡死）
  //   - terminal: false → 超长行 O(1)，但 canonical mode 破坏 IME composition 状态机 → 中文输入卡死
  //
  // raw mode 本身就能保 IME（豆包输入法实测正常），readline 的逐字符回显才是卡死根源。
  // 自管方案 = raw mode（保 IME）+ 追加式 echo O(1)（不重绘整行）+ 回车提交 + 光标编辑。

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

    // 自实现 scrollback（B6）：PgUp/PgDn + 滚轮（替代滚动模式发方向键）滚动输出
    const page = Math.max(1, ss.rows - 1);
    if (chunk === '\x1b[5~') { ss.scrollBy(page); return; }   // PgUp 向上
    if (chunk === '\x1b[6~') { ss.scrollBy(-page); return; }  // PgDn 向下
    if (chunk === '\x1b[A') { ss.scrollBy(page); return; }    // 滚轮上（替代滚动发 ↑）→ 看更早
    if (chunk === '\x1b[B') { ss.scrollBy(-page); return; }   // 滚轮下（发 ↓）→ 看更近
    // 非滚动输入：若在回滚态，先回到底（打字/编辑/提交都先回到最新输出）
    if (ss.scrolledBack) ss.scrollToBottom();

    const effect = applyChunk(model, chunk);

    if (effect.exit) { ss.leaveAltScreen(); ss.emit('\nBye.\n'); process.exit(0); return; }

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
      // 统一全量重绘：grid diff 已只写变化 cell（追加时只写新字符、编辑时只写改动区），
      // 不再触发 \x1b[J 全屏清（高频 \x1b[J 会腐败 nano malloc，输入法一打字就 SIGTRAP），
      // 也不软折行（软折行超长会触发 Terminal 渲染 bug 导致缺字）。append/redraw 两路合一。
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
      // 恢复主屏 + 关闭 bracketed paste + 恢复 raw mode，避免退出后终端状态残留
      ss.leaveAltScreen();
      ss.emit('\x1b[?2004l');
      if (typeof process.stdin.setRawMode === 'function') {
        try { process.stdin.setRawMode(false); } catch { /* 忽略 */ }
      }
      ss.emit('Bye.\n');
      process.exit(0);
    },
  };
}
