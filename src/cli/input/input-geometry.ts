/**
 * 输入几何 — 纯函数，零 I/O。
 * 从 cli.ts 原闭包逐字节提取，参数化为 (chars, cursor, cols, promptW)。
 * 延迟折行（DEC autowrap）数学与 cli.ts 完全一致：消费 term-wrap 的 shouldWrap（col + w > cols）。
 */
import { charWidth, shouldWrap } from '../render/term-wrap.js';

/** 光标所在的行和列（考虑 wrap + 显式 \n + 双宽）。
 *  line 从 0 起（第 0 行是 prompt 所在行），col 是该行的显示列。 */
export function cursorPos(chars: string[], cursor: number, cols: number, promptW: number): { line: number; col: number } {
  let line = 0, col = promptW;
  for (let i = 0; i < cursor; i++) {
    const c = chars[i];
    if (c === '\n') { line++; col = 0; continue; }
    const w = charWidth(c);
    if (shouldWrap(col, w, cols)) { line++; col = w; }  // 延迟折行，与终端 autowrap 一致
    else { col += w; }
  }
  return { line, col };
}

/** 内容占用的屏幕行数（从 prompt 行算起），用于重绘时上移清除。 */
export function contentLines(chars: string[], cols: number, promptW: number): number {
  let lines = 1, col = promptW;
  for (const c of chars) {
    if (c === '\n') { lines++; col = 0; continue; }
    const w = charWidth(c);
    if (shouldWrap(col, w, cols)) { lines++; col = w; }  // 延迟折行，与终端 autowrap 一致
    else { col += w; }
  }
  return lines;
}

/** 主动折行输入内容：超宽处插 \n，让终端不做软折行（与 cursorPos/contentLines 用同一 shouldWrap，行列一致）。 */
export function foldInput(chars: string[], cols: number, promptW: number): string {
  let col = promptW, out = '';
  for (const c of chars) {
    if (c === '\n') { out += '\n'; col = 0; continue; }
    const w = charWidth(c);
    if (shouldWrap(col, w, cols)) { out += '\n' + c; col = w; }
    else { out += c; col += w; }
  }
  return out;
}

/** 清洗粘贴输入里的终端控制序列（ANSI 码 + 回车符），防止污染 LLM 输入。 */
export function cleanInput(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')   // ANSI CSI 序列（颜色/光标）
    .replace(/\x1b\][^\x07]*\x07/g, '')         // OSC 序列
    .replace(/\x1b[()][A-Z0-9]/g, '')           // 字符集切换
    .replace(/\r/g, '');                        // 回车符（粘贴时终端换行是 \n，\r 是残留）
}
