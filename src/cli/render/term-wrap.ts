/**
 * 终端行宽工具 — CJK 双宽感知的折行。
 *
 * 超长行（LLM 输出的宽表格、长代码行）会触发 macOS Terminal.app 的 SwiftUI
 * 布局递归崩溃。折行保护只在需要的位置显式调用，不 monkey-patch 全局流。
 */

const ANSI_END = /^[A-Za-z]$/;

function charWidth(c: string): number {
  const code = c.codePointAt(0)!;
  if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)) return 2;
  if ((code >= 0x3000 && code <= 0x303F) || (code >= 0xFF01 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6)) return 2;
  if (code >= 0xAC00 && code <= 0xD7AF) return 2;
  if (code < 0x20 || (code >= 0x7F && code <= 0x9F)) return 0;
  return 1;
}

export function displayWidth(s: string): number {
  const clean = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let w = 0;
  for (const c of clean) w += charWidth(c);
  return w;
}

function breakLine(line: string, maxWidth: number): string {
  const parts: string[] = [];
  let visible = 0, lastBreak = 0;
  const sgrStack: string[] = []; // 追踪活跃的 ANSI SGR 码，断行后重新注入
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const start = i; i++;
      if (i < line.length && line[i] === '[') {
        i++;
        const seqStart = i;
        while (i < line.length && !ANSI_END.test(line[i])) i++;
        const seq = line.slice(seqStart, i);
        if (line[i] === 'm') {
          if (seq === '0') sgrStack.length = 0;
          else sgrStack.push(seq);
        }
      }
      if (i >= line.length || !ANSI_END.test(line[i])) i = start;
      continue;
    }
    visible += charWidth(line[i]);
    if (visible >= maxWidth) {
      parts.push(line.slice(lastBreak, i + 1));
      lastBreak = i + 1;
      visible = 0;
      // 断行后重新注入活跃的 ANSI 格式码
      if (sgrStack.length > 0) {
        parts.push(`\x1b[${sgrStack.join(';')}m`);
      }
    }
  }
  if (lastBreak < line.length) parts.push(line.slice(lastBreak));
  return parts.join('');
}

/**
 * 写入 stdout，对超长行自动折行。仅用于 LLM 输出等可能产生超长行的路径。
 * readline、进度渲染、banner 等短输出不经过此函数。
 */
export function safeWrite(text: string): void {
  const width = process.stdout.columns || 120;
  for (const line of text.split('\n')) {
    if (displayWidth(line) <= width) {
      process.stdout.write(line + '\n');
    } else {
      process.stdout.write(breakLine(line, width) + '\n');
    }
  }
}
