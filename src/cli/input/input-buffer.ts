/**
 * 输入缓冲 — 自建行编辑器：raw mode + 自管 stdin + bracketed paste + 光标编辑 + 折行 echo。
 * 与渲染器（renderer）完全解耦；所有终端写入经 ScreenState（单一屏幕模型）。
 */
import { cleanInput } from './input-geometry.js';
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
  // 字符数组（按 code point 分割，正确处理中文双宽 + emoji 代理对）
  let chars: string[] = [];
  // 光标位置（chars 索引，指向两个字符之间）
  let cursor = 0;
  // bracketed paste 状态：粘贴中 = true。粘贴内容里的 \r 是换行，不是回车提交。
  let inPaste = false;
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
    const { line, col } = ss.cursorPos(chars, cursor);
    ss.rewriteInput(ss.foldInput(chars), ss.contentLines(chars), line, col);
  };

  const settle = () => {
    if (!resolveLine) return;
    const text = cleanInput(chars.join('').trim());
    chars = [];
    cursor = 0;
    const resolve = resolveLine;
    resolveLine = null;
    resolve(text);
  };

  process.stdin.on('data', (chunk: string) => {
    if (closed) return;
    // Ctrl+C (0x03) 退出
    if (chunk === '\x03') { ss.emit('\nBye.\n'); process.exit(0); }
    // bracketed paste 开始标记：进入粘贴模式，后面的 \r 都是内容换行
    if (chunk.includes('\x1b[200~')) {
      inPaste = true;
      // 去掉开始标记，继续处理剩余内容
      chunk = chunk.replace(/\x1b\[200~/g, '');
      if (chunk === '') return;
    }
    // bracketed paste 结束标记：退出粘贴模式
    if (chunk.includes('\x1b[201~')) {
      inPaste = false;
      chunk = chunk.replace(/\x1b\[201~/g, '');
      if (chunk === '') return;
    }
    // Ctrl+D (0x04) 立即提交
    if (chunk === '\x04') { settle(); return; }
    // 回车提交：仅在非粘贴模式下，单独的 \r 或 \n chunk 才是回车
    if (!inPaste && (chunk === '\r' || chunk === '\n')) {
      settle();
      ss.submitInput();
      return;
    }
    // 方向键左/右（转义序列 \x1b[D / \x1b[C）—— 移动光标，重绘
    if (chunk === '\x1b[D') {
      if (cursor > 0) { cursor--; redraw(); }
      return;
    }
    if (chunk === '\x1b[C') {
      if (cursor < chars.length) { cursor++; redraw(); }
      return;
    }
    // Home / End（可选，完善光标编辑）
    if (chunk === '\x1b[H' || chunk === '\x1b[1~') { cursor = 0; redraw(); return; }
    if (chunk === '\x1b[F' || chunk === '\x1b[4~') { cursor = chars.length; redraw(); return; }
    // 退格（Backspace 0x7f 或 0x08）：删除光标前一个字符，双宽感知重绘
    if (chunk === '\x7f' || chunk === '\x08') {
      if (cursor > 0) {
        chars.splice(cursor - 1, 1);
        cursor--;
        redraw();
      }
      return;
    }
    // Delete（\x1b[3~）：删除光标后一个字符
    if (chunk === '\x1b[3~') {
      if (cursor < chars.length) {
        chars.splice(cursor, 1);
        redraw();
      }
      return;
    }

    // 普通输入：粘贴多行时 \r 转 \n（粘贴模式下 \r 是换行，非粘贴模式下 \r 也是换行）
    const text = chunk.replace(/\r/g, '\n');
    const newChars = Array.from(text);  // 按 code point 分割
    if (cursor === chars.length) {
      // 光标在末尾：追加 O(1) 折行 echo——从当前列开始折叠新 chunk（超宽插 \n），
      // 一次写入、不触发 \x1b[J（高频 \x1b[J 会腐败 nano malloc，输入法一打字就 SIGTRAP），
      // 也不软折行（软折行超长会触发 Terminal 渲染 bug 导致缺字）。两者兼顾。
      const { col: startCol } = ss.cursorPos(chars, cursor);  // 新字符前的光标列（含 prompt 宽）
      chars.push(...newChars);
      cursor = chars.length;
      ss.appendInput(ss.foldInput(newChars, startCol), ss.contentLines(chars));
    } else {
      // 光标在中间：插入 + 折行重绘（编辑操作低频，可接受）
      chars.splice(cursor, 0, ...newChars);
      cursor += newChars.length;
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
        chars = [];
        cursor = 0;
        ss.printPrompt();
      });
    },

    close(): void {
      closed = true;
      // 关闭 bracketed paste + 恢复 raw mode，避免退出后终端状态残留
      ss.emit('\x1b[?2004l');
      if (typeof process.stdin.setRawMode === 'function') {
        try { process.stdin.setRawMode(false); } catch { /* 忽略 */ }
      }
      ss.emit('Bye.\n');
      process.exit(0);
    },
  };
}
