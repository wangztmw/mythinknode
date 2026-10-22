/**
 * 行内标记解析 + CJK 折行（带标点避头尾）。
 *
 * 仅用于 CJK 占比高的文本；英文文本仍交给 Ink 的按词折行。
 */
import { displayWidth, graphemes } from '../text/width.js';

export interface InlineSegment {
  text: string;
  bold?: boolean;
  code?: boolean;
  italic?: boolean;
  color?: string;
}

/** 解析 **粗体** / `代码` / *斜体* / [链接](url) */
export function parseInline(text: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push({ text: text.slice(last, match.index) });

    const token = match[0];
    if (token.startsWith('**')) {
      out.push({ text: token.slice(2, -2), bold: true });
    } else if (token.startsWith('`')) {
      out.push({ text: token.slice(1, -1), code: true });
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        out.push({ text: link[1] });
        if (link[2] !== link[1]) out.push({ text: ` (${link[2]})`, color: 'gray' });
      } else {
        out.push({ text: token });
      }
    } else {
      out.push({ text: token.slice(1, -1), italic: true });
    }

    last = match.index + token.length;
  }

  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// 避头尾：这些字符不能出现在行首
const NO_LINE_START = new Set([...'。，、；：！？）〕］｝〉》」』】…‥・：；,.!?)]}']);
// 这些字符不能出现在行尾
const NO_LINE_END = new Set([...'（〔［｛〈《「『【']);

function sameStyle(a: InlineSegment, b: InlineSegment): boolean {
  return !!a.bold === !!b.bold
    && !!a.code === !!b.code
    && !!a.italic === !!b.italic
    && a.color === b.color;
}

function styleOf(segment: InlineSegment): InlineSegment {
  return { text: '', bold: segment.bold, code: segment.code, italic: segment.italic, color: segment.color };
}

/** 从当前行尾取出一个 grapheme（用于避头时把上一字符带到下一行） */
function popLastGrapheme(line: InlineSegment[]): { char: string; style: InlineSegment; width: number } | null {
  const last = line[line.length - 1];
  if (!last) return null;

  const chars = graphemes(last.text);
  const char = chars.pop() ?? '';
  if (!char) return null;

  last.text = chars.join('');
  const style = styleOf(last);
  if (!last.text) line.pop();

  return { char, style, width: displayWidth(char) };
}

/**
 * 按显示宽度折行，保持行内样式，并应用简单的中文避头尾规则。
 */
export function wrapSegments(segments: InlineSegment[], width: number): InlineSegment[][] {
  const safeWidth = Math.max(1, width);
  const lines: InlineSegment[][] = [[]];
  let lineWidth = 0;

  const append = (char: string, style: InlineSegment): void => {
    const line = lines[lines.length - 1];
    const last = line[line.length - 1];
    if (last && sameStyle(last, style)) {
      last.text += char;
    } else {
      line.push({ ...styleOf(style), text: char });
    }
  };

  for (const segment of segments) {
    for (const char of graphemes(segment.text)) {
      const charWidth = displayWidth(char);

      if (lineWidth + charWidth > safeWidth && lineWidth > 0) {
        if (NO_LINE_START.has(char)) {
          // 避头：把当前行最后一个字符带到下一行，再放标点，避免标点单独起行
          const moved = popLastGrapheme(lines[lines.length - 1]);
          lines.push([]);
          lineWidth = 0;

          if (moved) {
            append(moved.char, moved.style);
            lineWidth += moved.width;
            if (lineWidth + charWidth > safeWidth) {
              lines.push([]);
              lineWidth = 0;
            }
          }
          // moved 为空（当前行只有一个字符）时，宁可标点起行也不截断内容
        } else {
          const line = lines[lines.length - 1];
          const lastSegment = line[line.length - 1];
          const lastChar = lastSegment
            ? (graphemes(lastSegment.text).at(-1) ?? '')
            : '';

          if (lastSegment && NO_LINE_END.has(lastChar)) {
            // 避尾：把开括号/开引号移到下一行
            const style = styleOf(lastSegment);
            const chars = graphemes(lastSegment.text);
            chars.pop();
            lastSegment.text = chars.join('');
            if (!lastSegment.text) line.pop();

            lines.push([]);
            lineWidth = 0;
            append(lastChar, style);
            lineWidth += displayWidth(lastChar);

            if (lineWidth + charWidth > safeWidth) {
              lines.push([]);
              lineWidth = 0;
            }
          } else {
            lines.push([]);
            lineWidth = 0;
          }
        }
      }

      append(char, segment);
      lineWidth += charWidth;
    }
  }

  return lines;
}
