/**
 * 终端行宽工具 — CJK 双宽感知的折行。
 *
 * 超长行（LLM 输出的宽表格、长代码行）会触发 macOS Terminal.app 的 SwiftUI
 * 布局递归崩溃。折行保护只在需要的位置显式调用，不 monkey-patch 全局流。
 */

const ANSI_END = /^[A-Za-z]$/;

export function charWidth(c: string): number {
  const code = c.codePointAt(0)!;
  if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)) return 2;
  if ((code >= 0x3000 && code <= 0x303F) || (code >= 0xFF01 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6)) return 2;
  if (code >= 0xAC00 && code <= 0xD7AF) return 2;
  // emoji / 双宽符号（大部分终端宽 2）。surrogate 对由 writeAnsiText/wrapLine 按 code unit
  // 各算 1 共 2；displayWidth 按 code point 进到这里，需显式返回 2，否则「是否需折行」判错。
  if (code >= 0x1F000 && code <= 0x1FAFF) return 2;
  if (code >= 0x2600 && code <= 0x27BF) return 2;
  if (code < 0x20 || (code >= 0x7F && code <= 0x9F)) return 0;
  return 1;
}

export function displayWidth(s: string): number {
  const clean = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let w = 0;
  for (const c of clean) w += charWidth(c);
  return w;
}

/**
 * 延迟折行（DEC autowrap）判定：光标当前在第 `col` 列（0 起），要写一个宽 `w` 的字符，
 * 是否需要先折到下一行。
 *
 * 终端（xterm / Terminal.app / iTerm2）的真实行为是「延迟折行」：
 *   - 宽 1 的字符可以放进最后一列（第 cols-1 列），光标进入 pending-wrap（本模型用 col==cols 表示）；
 *   - 直到「下一个」字符才真正折行；
 *   - 宽 2 的字符塞不进最后一列（需要 cols-1、cols 两列，只剩一列），此时提前折行。
 *
 * 因此折行条件是 `col + w > cols`（而非 `>=`）。用 `>=` 会在「正好写满最后一列」时提前折行，
 * 让 cursorPos/contentLines 与终端实际渲染不一致 —— 输入层自管光标与输出层/终端对光标位置的认知
 * 就此错开，累积几轮后 redraw 的 \x1b[{n}A / \x1b[{col}C 定位错误，出现空位、少字甚至把终端弄崩。
 */
export function shouldWrap(col: number, w: number, cols: number): boolean {
  return col + w > cols;
}

/**
 * 把一行逻辑文本主动折成多个可视行（每行显示宽 ≤ cols），ANSI SGR 跨行保留。
 * 折行点与终端延迟 autowrap 一致（写满 cols 后下一个字符才折）。
 *
 * 用于 screen-state 的 writeLines：保证写入终端的每一行都不超过终端宽度，避免超长单行触发
 * Terminal.app SwiftUI 布局递归崩溃（malloc corruption）。
 */
export function wrapLine(line: string, cols: number): string[] {
  if (displayWidth(line) <= cols) return [line];
  const rows: string[] = [];
  let cur = '';
  let curW = 0;
  const sgr: string[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const start = i; i++;
      if (i < line.length && line[i] === '[') {
        i++;
        const seqStart = i;
        while (i < line.length && !ANSI_END.test(line[i])) i++;
        const seq = line.slice(seqStart, i);
        if (line[i] === 'm') { if (seq === '0') sgr.length = 0; else sgr.push(seq); }
      }
      cur += line.slice(start, i + 1);
      continue;
    }
    const w = charWidth(line[i]);
    if (curW + w > cols && curW > 0) {
      rows.push(cur);
      cur = sgr.length ? `\x1b[${sgr.join(';')}m` : '';
      curW = 0;
    }
    cur += line[i];
    curW += w;
  }
  rows.push(cur);
  return rows;
}
