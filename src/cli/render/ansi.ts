/**
 * Markdown → ANSI 终端格式化
 * 零外部依赖，非 TTY 自动降级
 */

const C = '\x1b[36m';
const B = '\x1b[1m';   const b = '\x1b[22m';
const D = '\x1b[2m';   const d = '\x1b[22m';
const G = '\x1b[90m';  const c = '\x1b[39m';

// CJK 双宽感知的字符串长度（用于表格对齐等）
function charW(c: string): number {
  const code = c.codePointAt(0)!;
  if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) || (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0xFF01 && code <= 0xFF60) || (code >= 0xFFE0 && code <= 0xFFE6) ||
      (code >= 0xAC00 && code <= 0xD7AF)) return 2;
  if (code < 0x20 || (code >= 0x7F && code <= 0x9F)) return 0;
  return 1;
}
function visualLen(s: string): number { let w = 0; for (const c of s) w += charW(c); return w; }
function visualPad(s: string, n: number): string {
  const w = visualLen(s);
  return w >= n ? s : s + ' '.repeat(n - w);
}

export function mdToANSI(text: string): string {
  // 非TTY(管道/重定向) → 纯文本
  if (!process.stdout.isTTY) return text.replace(/```[\s\S]*?```/g, '[code]').replace(/[*#`|>-]/g, '');
  // 超长文本→纯文本(防止Terminal缓冲区溢出——macOS persistent UI内存bug)
  if (text.length > 8000) return text.replace(/```[\s\S]*?```/g, '[code]').replace(/[*#`|>-]/g, '');

  let result = text;
  // 代码块
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) =>
    `\n${D}${code.trim()}${d}\n`);
  // 行内代码
  result = result.replace(/`([^`]+)`/g, `${D}$1${d}`);
  // 粗体
  result = result.replace(/\*\*(.+?)\*\*/g, `${B}$1${b}`);
  // 标题（先处理长标题再短，避免###被##误匹配）
  result = result.replace(/^### (.+)$/gm, `${B}$1${b}`);
  result = result.replace(/^## (.+)$/gm, `${B}$1${b}`);
  result = result.replace(/^# (.+)$/gm, `${B}$1${b}`);
  // 列表
  result = result.replace(/^(\s*)- /gm, '  • ');
  // 表格分隔行
  result = result.replace(/^\|[-| ]+\|$/gm, '');
  // 表格行
  result = result.replace(/^\|(.+)\|$/gm, (_, row) => {
    const cells = row.split('|').map((s: string) => s.trim());
    return '  ' + cells.map((s: string) => visualPad(s, 20)).join(' ').trim();
  });
  // 水平线
  result = result.replace(/^---$/gm, `${G}${'─'.repeat(60)}${c}`);
  // 引用
  result = result.replace(/^> (.+)$/gm, `${G}│ $1${c}`);
  // 安全：确保ANSI码平衡(未闭合的粗体/灰色 → 关闭)
  let bOpen = 0, dOpen = 0;
  const re = /\x1b\[(1|22|2)m/g; let m;
  while ((m = re.exec(result)) !== null) {
    if (m[1] === '1') bOpen++;
    else if (m[1] === '22') { bOpen = Math.max(0, bOpen - 1); dOpen = Math.max(0, dOpen - 1); } // 22 同时关闭 bold 和 dim
    else if (m[1] === '2') dOpen++;
  }
  if (bOpen > 0) result += b.repeat(bOpen);
  if (dOpen > 0) result += d.repeat(dOpen);
  // 去掉残留的未配对*号
  result = result.replace(/^\*{1,2}(?!\*)/gm, '').replace(/(?<!\*)\*{1,2}$/gm, '');
  return result;
}

/** ANSI 粗体标签（给 CLI 用） */
export { C, B, b, D, d, G, c };
