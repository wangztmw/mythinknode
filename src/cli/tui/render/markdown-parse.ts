/**
 * Markdown 解析（TUI 专用，纯函数）。
 *
 * 关键语义：段落内的单个换行是「软换行」，需要合并后交给 Ink 按当前宽度重排；
 * 行尾两个以上空格或反斜杠是硬换行，必须保留。
 */
export interface MdListItem {
  indent: number;
  ordered: boolean;
  marker: string;
  text: string;
}

export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: MdListItem[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; lang: string; lines: string[] }
  | { type: 'table'; rows: string[][] }
  | { type: 'rule' };

// CJK：全角标点、扩展 A、基本区、兼容区、全角字符、谚文
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;

function isCjk(char: string): boolean {
  return char.length > 0 && CJK.test(char);
}

/**
 * 中文按字折行更整齐；英文必须按词折行，避免拆断单词。
 * CJK 字符占比达到 30% 时使用 hard。
 */
export function preferredWrapMode(text: string): 'wrap' | 'hard' {
  const visible = text.replace(/\s/g, '');
  if (!visible) return 'wrap';

  let cjkCount = 0;
  for (const char of visible) {
    if (isCjk(char)) cjkCount++;
  }
  return cjkCount / visible.length >= 0.3 ? 'hard' : 'wrap';
}

/** 合并段落/列表/引用中的软换行；硬换行保留 */
export function joinSoftLines(lines: string[]): string {
  let out = '';
  let pendingHard = false;

  for (const raw of lines) {
    if (raw.trim() === '') continue;

    let line = raw.trim();
    let hard = / {2,}$/.test(raw);
    if (line.endsWith('\\')) {
      hard = true;
      line = line.slice(0, -1).trimEnd();
    }

    if (out === '') {
      out = line;
      pendingHard = hard;
      continue;
    }

    if (pendingHard) {
      out += '\n' + line;
    } else {
      const prev = out.slice(-1);
      const next = line.charAt(0);
      out += (isCjk(prev) && isCjk(next)) ? line : ' ' + line;
    }
    pendingHard = hard;
  }

  return out;
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line);
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}

function isRule(line: string): boolean {
  return /^\s*[-*_]{3,}\s*$/.test(line);
}

function isBlockStart(line: string): boolean {
  return isFence(line)
    || /^#{1,3}\s+/.test(line)
    || /^\s*[-*]\s+/.test(line)
    || /^\s*\d+\.\s+/.test(line)
    || /^\s*>/.test(line)
    || isTableRow(line)
    || isRule(line);
}

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];

    if (raw.trim() === '') {
      i++;
      continue;
    }

    // 代码块：保留原始行
    if (isFence(raw)) {
      const lang = raw.replace(/^\s*```/, '').trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', lang, lines: code });
      continue;
    }

    // 表格
    if (isTableRow(raw)) {
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        if (!isTableSeparator(lines[i])) rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', rows });
      continue;
    }

    // 标题
    const heading = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim(),
      });
      i++;
      continue;
    }

    // 分隔线
    if (isRule(raw)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    // 引用：合并续行
    if (/^\s*>/.test(raw)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: joinSoftLines(quoteLines) });
      continue;
    }

    // 列表：合并 item 续行
    const listMatch = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(raw);
    if (listMatch) {
      const items: MdListItem[] = [];
      while (i < lines.length) {
        const match = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!match) break;

        const itemLines = [match[3]];
        i++;
        while (i < lines.length) {
          const line = lines[i];
          if (!line.trim()) break;
          if (/^\s*([-*]|\d+\.)\s+/.test(line)) break;
          if (isFence(line) || /^#{1,3}\s+/.test(line) || /^\s*>/.test(line) || isTableRow(line) || isRule(line)) break;
          itemLines.push(line);
          i++;
        }

        items.push({
          indent: Math.min(3, Math.floor(match[1].length / 2)),
          ordered: /^\d/.test(match[2]),
          marker: /^\d/.test(match[2]) ? match[2] : '',
          text: joinSoftLines(itemLines),
        });

        if (i < lines.length && !lines[i].trim()) break;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // 段落：合并软换行，交给渲染层按宽度重排
    const paragraph: string[] = [raw];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: joinSoftLines(paragraph) });
  }

  return blocks;
}
