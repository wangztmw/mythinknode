/**
 * 会话选择器 —— 纯逻辑，不依赖 CLI / 不依赖 Ink。
 *
 * 为什么要单独一个模块：`Session.pickSession()` 在 `createCLI()` 之前执行
 * （要先知道 session 是谁，才能准备欢迎框数据），所以它用不了 `cli.readLine()`。
 * 而原来那版直接 `process.stdin.once('data')` + `console.log`，既不可测，
 * 又有几个字节边界缺陷（详见 plan.md）。
 *
 * 这里把「怎么读一行」「怎么解析选择」「怎么排版」三件事拆开，
 * I/O 通过参数注入，单测可以喂任意分帧序列。
 */
import type { ChatMessage } from '../llm/types.js';

/** 最小 I/O 接口，便于注入假对象 */
export interface PickerIO {
  stdin: {
    on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
    off?(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
    removeListener?(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
    resume?(): void;
    pause?(): void;
  };
  stdout: { write(text: string): unknown };
}

export interface SessionRow {
  id: string;
  messages: number;
  toolCount: number;
  startedAt?: number;
}

/** 一次读取的三种结局。用三态而不是 string|null：null 无法区分「取消」和「开新会话」。 */
export type ReadResult =
  | { kind: 'line'; text: string }
  | { kind: 'abort' }
  | { kind: 'eof' };

export type Choice =
  | { kind: 'index'; n: number }
  | { kind: 'new' }
  | { kind: 'invalid'; reason: string };

/**
 * ANSI 转义序列（终端可能在用户输入前先发来光标/鼠标序列）。
 *
 * CSI 的终止字节是 0x40-0x7E，不只是字母 —— `\x1b[2~`（Insert 键）的终止符是 `~`，
 * 写成 `[A-Za-z]` 会漏掉它，导致 `~` 残留在输入里（实测踩过）。
 * 与 cli/tui/text/sanitize.ts 的 CSI 正则保持一致。
 */
const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007]*\u0007|\u001B[@-_]/g;

/** 列表最多显示多少条，避免刷屏 */
export const MAX_ROWS = 20;

/**
 * 从 stdin 累积到第一个换行，返回整行。
 *
 * 关键点（对照旧实现 `stdin.once('data')` 的缺陷）：
 *   1. 没到换行就继续等 —— 分帧到达不会早退，粘贴 `'12\r'` 能拿到完整 `'12'`
 *   2. 剥掉 ANSI 转义后再找换行 —— 终端开机序列不会污染输入
 *   3. `\x03` → abort、`\x04` → eof、stdin 关闭 → eof，三种结局显式区分
 *      （旧实现把 Ctrl+C 的 NaN 当成「开新会话」）
 */
export function readLineOnce(io: PickerIO): Promise<ReadResult> {
  return new Promise<ReadResult>(resolve => {
    let pending = '';
    let settled = false;

    const cleanup = (): void => {
      settled = true;
      const off = io.stdin.off ?? io.stdin.removeListener;
      if (off) off.call(io.stdin, 'data', onData);
    };
    const finish = (r: ReadResult): void => {
      if (settled) return;
      cleanup();
      resolve(r);
    };

    const onData = (chunk: string | Buffer): void => {
      if (settled) return;
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      // 控制字符优先：即使和文本混在一起也要立即处理
      if (pending.includes('\x03')) return finish({ kind: 'abort' });
      if (pending.includes('\x04')) return finish({ kind: 'eof' });

      pending = pending.replace(ANSI_RE, '');

      const m = pending.match(/\r\n|\r|\n/);
      if (!m || m.index === undefined) return;   // 还没到换行：继续等

      const line = pending.slice(0, m.index).trim();
      finish({ kind: 'line', text: line });
    };

    // stdin 提前关闭（Ctrl+D 在 cooked 模式下可能直接触发 end）
    const onEnd = (): void => finish({ kind: 'eof' });
    const stdinAny = io.stdin as unknown as {
      once?(e: 'end', l: () => void): unknown;
      on(e: 'end', l: () => void): unknown;
    };
    if (stdinAny.once) stdinAny.once('end', onEnd);

    io.stdin.on('data', onData);
    io.stdin.resume?.();
  });
}

/**
 * 文本 → 选择结果。
 *
 * 刻意用 `/^\d+$/` 而不是 `parseInt`：
 *   parseInt('12abc')  = 12      ← 「尽力猜」，会把打错的输入误判成有效选择
 *   parseInt('\x033')  = 3       ← 更危险：把 Ctrl+C 当成选 3
 *   /^\d+$/ 则明确拒绝。选择会话场景应该「明确拒绝」，不是「尽量猜」。
 */
export function parseChoice(text: string, max: number): Choice {
  const t = text.trim();
  if (t === '') return { kind: 'new' };          // 空回车 = 开新会话（保留原语义）
  if (!/^\d+$/.test(t)) return { kind: 'invalid', reason: '请输入数字' };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 1 || n > max) {
    return { kind: 'invalid', reason: `请输入 1-${max} 之间的数字` };
  }
  return { kind: 'index', n };
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 */
export function formatRelative(ts: number | undefined, now: number = Date.now()): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const diff = now - ts;
  if (diff < 0) return '';
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return `${Math.floor(diff / (30 * day))} 个月前`;
}

/**
 * 从目录名 `YYYYMMDD-HHMM` 前缀解析开始时间（老会话没有 startedAt 字段时兜底）。
 * 解析失败返回 undefined —— 调用方把它当「时间未知」处理，不能让整行格式错乱。
 */
export function parseStartedAtFromId(id: string): number | undefined {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m;
  const ts = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

/** 会话列表 → 可直接 write 的文本 */
export function formatSessionList(
  rows: SessionRow[],
  lastId: string | null,
  now: number = Date.now(),
): string {
  const shown = rows.slice(0, MAX_ROWS);
  const lines: string[] = [`可用会话（${rows.length} 个）：`, ''];

  // 序号宽度随最大条数自适应，保证列对齐
  const numWidth = String(shown.length).length;
  // 名字列宽度：按可见宽度粗略取最长的前 40 个字符
  const nameWidth = Math.min(
    44,
    Math.max(...shown.map(r => r.id.length), 10),
  );

  for (let i = 0; i < shown.length; i++) {
    const r = shown[i];
    const num = String(i + 1).padStart(numWidth, ' ');
    const name = r.id.length > nameWidth ? `${r.id.slice(0, nameWidth - 1)}…` : r.id;
    const rel = formatRelative(r.startedAt ?? parseStartedAtFromId(r.id), now);
    const mark = lastId && r.id === lastId ? '  ← 上次' : '';
    lines.push(
      `  ${num}. ${name.padEnd(nameWidth, ' ')}  ${rel.padEnd(8, ' ')}  ${r.messages} 条消息${mark}`,
    );
  }

  if (rows.length > shown.length) {
    lines.push(`  … 还有 ${rows.length - shown.length} 个（列表中只显示最近 ${MAX_ROWS} 个）`);
  }

  lines.push('', '输入序号恢复，直接回车开新会话：');
  return lines.join('\n') + '\n';
}

export type PickOutcome =
  | { kind: 'picked'; id: string }
  | { kind: 'new' }
  | { kind: 'abort' };

/**
 * 显示列表 → 读一行 → 解析 → 必要时重问。
 *
 * 重问上限 3 次：会话选择不是关键决策（会话文件还在磁盘上，下次还能选），
 * 不必像密码那样死循环。3 次覆盖手滑足够，之后按「开新会话」处理，不让用户卡死。
 */
export async function pickSessionFrom(
  io: PickerIO,
  rows: SessionRow[],
  lastId: string | null,
  opts: { maxRetries?: number; now?: number } = {},
): Promise<PickOutcome> {
  if (rows.length === 0) return { kind: 'new' };
  const maxRetries = opts.maxRetries ?? 3;

  io.stdout.write(formatSessionList(rows, lastId, opts.now ?? Date.now()));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await readLineOnce(io);
    if (r.kind === 'abort') return { kind: 'abort' };
    if (r.kind === 'eof') return { kind: 'new' };

    const choice = parseChoice(r.text, rows.length);
    if (choice.kind === 'index') return { kind: 'picked', id: rows[choice.n - 1].id };
    if (choice.kind === 'new') return { kind: 'new' };

    if (attempt === maxRetries) {
      io.stdout.write(`已 ${maxRetries + 1} 次无效输入，按开新会话处理。\n`);
      return { kind: 'new' };
    }
    io.stdout.write(`无效输入（${choice.reason}），请重试，或直接回车开新会话：\n`);
  }
  return { kind: 'new' };
}

/** 会话消息里取第一句真实用户输入，供列表预览（可选） */
export function previewOf(messages: ChatMessage[], maxLen = 40): string {
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    const t = m.content.trim();
    if (!t || t.startsWith('[')) continue;
    return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
  }
  return '';
}
