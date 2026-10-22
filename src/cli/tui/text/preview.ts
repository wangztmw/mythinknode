/**
 * 语义预览 — 按逻辑行/字符上限截断，与终端宽度无关。
 * 生产端（session.tsx）使用；可视行折叠由 render/* 负责。
 */
import { truncateGraphemes } from './width.js';

export interface TextPreview {
  text: string;
  totalLines: number;
  shownLines: number;
  truncated: boolean;
}

export function buildPreview(text: string, maxLines: number, maxChars: number): TextPreview {
  const all = text.split('\n');
  const totalLines = all.length;
  const kept: string[] = [];
  let chars = 0;
  let charCapHit = false;

  for (const line of all) {
    if (kept.length >= maxLines) break;
    const separator = kept.length > 0 ? 1 : 0;
    if (chars + separator + line.length > maxChars) {
      charCapHit = true;
      if (kept.length === 0) {
        kept.push(truncateGraphemes(line, Math.max(1, maxChars)));
      }
      break;
    }
    kept.push(line);
    chars += separator + line.length;
  }

  return {
    text: kept.join('\n'),
    totalLines,
    shownLines: kept.length,
    truncated: charCapHit || kept.length < totalLines,
  };
}
