/**
 * 显示宽度工具 — 基于 string-width，与 wrap-ansi / Ink 使用同一套宽度语义。
 * 不再依赖旧 UI 的 term-wrap.ts。
 */
import stringWidth from 'string-width';

export function displayWidth(text: string): number {
  return stringWidth(text);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 按 grapheme 拆分（emoji/组合字符不会被拆开） */
export function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

/** 按显示宽度截断，末尾加省略号（不会切断 grapheme） */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(text) <= maxWidth) return text;

  const ellipsisWidth = displayWidth(ellipsis);
  const budget = Math.max(0, maxWidth - ellipsisWidth);
  const head = takeWidth(text, budget);
  if (budget === 0) return takeWidth(ellipsis, maxWidth);
  return head + ellipsis;
}

/**
 * 可用内容宽度 = 终端宽度 − 预留（前缀 / 边距）。
 *
 * **恒 ≤ columns − reserved，这是硬约束不是建议。**
 *
 * 旧写法 `Math.max(10, columns - reserved)` 的意图是「太窄也别挤，保持 10 列可读」，
 * 但它假设了 `columns - reserved ≥ 10`。一旦不成立，兜底反而制造越界：
 *
 *   终端 8 列 → 可用 8 − 2 = 6，但 max(10, 6) = 10 → 宽出 4 列
 *   ├─ Text 类：我们按 10 折，Ink 再按容器宽度折一次 → 双重折行、参差不齐
 *   └─ Box 类（表格单元格有显式 width）：Ink 不再折 → 真的溢出，终端二次折行整屏错乱
 *
 * 可读性不能靠越界去换：8 列下 10 列和 6 列一样不可读，但 10 列一定难看。
 */
export function contentWidth(columns: number, reserved = 0): number {
  const available = columns - reserved;
  return available >= 1 ? available : 1;
}


/** 按 grapheme 数量截断（用于语义字符上限） */
export function truncateGraphemes(text: string, maxGraphemes: number): string {
  if (maxGraphemes <= 0) return '';
  let out = '';
  let count = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (count >= maxGraphemes) break;
    out += segment;
    count++;
  }
  return out;
}

function takeWidth(text: string, maxWidth: number): string {
  let out = '';
  let width = 0;
  for (const { segment } of segmenter.segment(text)) {
    const segmentWidth = displayWidth(segment);
    if (width + segmentWidth > maxWidth) break;
    out += segment;
    width += segmentWidth;
  }
  return out;
}
