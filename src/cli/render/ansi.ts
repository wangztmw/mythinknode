/**
 * Markdown → ANSI 终端格式化
 * 零外部依赖，非 TTY 自动降级
 */
import { charWidth } from './term-wrap.js';

const C = '\x1b[36m';
const B = '\x1b[1m';   const b = '\x1b[22m';
const c = '\x1b[39m';

// CJK 双宽感知的字符串长度（用于表格对齐等）—— 复用 term-wrap 的唯一宽度表
function visualLen(s: string): number { let w = 0; for (const c of s) w += charWidth(c); return w; }
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
  // 代码块（不再加 dim 灰——减少 ANSI 属性段，降低 Terminal 重绘的小对象分配，缓解 nano 腐败）
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) =>
    `\n${code.trim()}\n`);
  // 行内代码
  result = result.replace(/`([^`]+)`/g, '$1');
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
  // 水平线（不再加灰）
  result = result.replace(/^---$/gm, `${'─'.repeat(60)}`);
  // 引用（不再加灰）
  result = result.replace(/^> (.+)$/gm, `│ $1`);
  // 安全：确保ANSI码平衡(未闭合的粗体 → 关闭)
  let bOpen = 0;
  const re = /\x1b\[(1|22)m/g; let m;
  while ((m = re.exec(result)) !== null) {
    if (m[1] === '1') bOpen++;
    else if (m[1] === '22') bOpen = Math.max(0, bOpen - 1); // 22 关闭 bold
  }
  if (bOpen > 0) result += b.repeat(bOpen);
  // 去掉残留的未配对*号
  result = result.replace(/^\*{1,2}(?!\*)/gm, '').replace(/(?<!\*)\*{1,2}$/gm, '');
  return result;
}

/** ANSI 标签（给 CLI 用） */
export { C, B, b, c };
