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
