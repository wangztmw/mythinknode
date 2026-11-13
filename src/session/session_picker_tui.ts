/**
 * 交互式会话选择器（raw mode + 方向键 + 滚动视口 + 内容预览）。
 *
 * 为什么不复用 Ink：`pickSession()` 在 `createCLI()` **之前**执行（要先知道
 * session 是谁，才能准备欢迎框数据）。若在这里起一个 Ink 实例，选完还要
 * unmount，再让 createTuiCLI 起第二个 —— 两个 Ink 实例先后接管 stdout，
 * raw mode / 光标状态的交接是已知的麻烦来源
 * （见 Plan/20261110-1035-tui-input-deadlock）。
 *
 * 分层：
 *   parseKey   转义序列 → 语义按键（含分帧累积，见 lessons/L05）
 *   applyKey   纯状态机，返回新状态或终局 —— 可脱离终端单测
 *   layout     计算视口/预览行数 —— 纯函数
 *   render     生成整帧文本 —— 可断言
 *   pickSessionInteractive  只做 I/O 接线
 */
import type { SessionRow, PickOutcome, PreviewBlock } from './session_picker.js';
import { formatRelative, parseStartedAtFromId, previewMessages } from './session_picker.js';

// ---------------------------------------------------------------- 按键

export type KeyName =
  | 'up' | 'down' | 'page-up' | 'page-down' | 'home' | 'end'
  | 'enter' | 'backspace' | 'escape'
  | 'abort'        // Ctrl+C
  | 'eof'          // Ctrl+D
  | 'new'          // n
  | 'char'         // 其他可打印字符
  | 'ignore';

export interface ParsedKey {
  name: KeyName;
  /** name==='char' 时的字符 */
  char?: string;
}

/** 转义序列 → 语义按键 */
const ESC_SEQUENCES: Array<[string, KeyName]> = [
  ['\x1b[A', 'up'], ['\x1bOA', 'up'],
  ['\x1b[B', 'down'], ['\x1bOB', 'down'],
  ['\x1b[5~', 'page-up'], ['\x1b[6~', 'page-down'],
  ['\x1b[H', 'home'], ['\x1b[1~', 'home'], ['\x1bOH', 'home'],
  ['\x1b[F', 'end'], ['\x1b[4~', 'end'], ['\x1bOF', 'end'],
];

/**
 * 解析一个 chunk。返回 null 表示「这是转义序列的前半截，需要等后续字节」。
 *
 * 为什么需要这个：方向键是 `\x1b[A`，若被拆成 `\x1b` + `[A` 两帧，
 * 第一帧会被误判成 Esc（→ 退出）。这与 lessons/L05「一个读事件 ≠ 一个逻辑输入」
 * 是同一个问题，处理方式也相同：**没到终止字节就继续等**。
 */
export function parseKey(chunk: string): ParsedKey | null {
  if (!chunk) return { name: 'ignore' };

  // Ctrl 组合优先：它们一定是完整的单字节
  if (chunk.includes('\x03')) return { name: 'abort' };
  if (chunk.includes('\x04')) return { name: 'eof' };

  for (const [seq, name] of ESC_SEQUENCES) {
    if (chunk === seq) return { name };
    if (chunk.startsWith(seq)) {
      // 序列后有剩余字符（如 `\x1b[A` + 其他）→ 只取第一个按键
      return { name };
    }
  }

  // 以 ESC 开头但还不成形：可能是半截方向键
  if (chunk === '\x1b') {
    // 单独一个 ESC 只能是 Esc 键 —— 但要给后续字节一个机会。
    // 调用方（readKeys 的累积器）会等 ~30ms 再判定，这里返回 null 表示"待定"。
    return null;
  }
  if (chunk.startsWith('\x1b') && /^\x1b(\[[0-9;]*)?$/.test(chunk)) {
    return null;   // 半截 CSI 序列，继续等
  }
  if (chunk.startsWith('\x1b')) {
    return { name: 'escape' };   // 无法识别的转义序列，当 Esc 处理
  }
  // 方向键的尾部残片（上一次累积的剩余）
  if (/^\[[A-Z0-9;~]*$/.test(chunk)) return { name: 'ignore' };

  const ch = chunk[0];
  if (ch === '\r' || ch === '\n') return { name: 'enter' };
  if (ch === '\x7f' || ch === '\b') return { name: 'backspace' };
  if (ch === 'k') return { name: 'up' };
  if (ch === 'j') return { name: 'down' };
  if (ch === 'g') return { name: 'home' };
  if (ch === 'G') return { name: 'end' };
  if (ch === 'n' || ch === 'N') return { name: 'new' };
  if (ch === 'q' || ch === 'Q') return { name: 'abort' };
  return { name: 'char', char: ch };
}

/** Esc 待定超时：等这么久没有后续字节，就认为用户按的是 Esc 键本身 */
export const ESC_TIMEOUT_MS = 40;

// ---------------------------------------------------------------- 状态机

export interface PickerState {
  cursor: number;
  scrollTop: number;
  /** 已累积的数字（支持"输 12 跳转"） */
  digits: string;
  /** 一次性状态提示（越界等），下一次按键清空 */
  notice: string | null;
}

export function initialState(rows: SessionRow[], lastId: string | null): PickerState {
  const idx = lastId ? rows.findIndex(r => r.id === lastId) : -1;
  return {
    cursor: idx >= 0 ? idx : 0,
    // 初始视口要让「上次那个」可见
    scrollTop: 0,
    digits: '',
    notice: null,
  };
}

export type KeyResult =
  | { kind: 'state'; state: PickerState }
  | { kind: 'done'; outcome: PickOutcome };

/**
 * 纯状态机：给定当前状态 + 一个按键，返回新状态或终局。
 *
 * 不涉及任何 I/O —— 这是能被单测覆盖的关键。
 */
export function applyKey(
  state: PickerState,
  key: ParsedKey,
  rows: SessionRow[],
  pageSize: number,
): KeyResult {
  const n = rows.length;
  const clamp = (v: number): number => Math.max(0, Math.min(n - 1, v));

  switch (key.name) {
    case 'ignore':
      return { kind: 'state', state };

    case 'abort':
      return { kind: 'done', outcome: { kind: 'abort' } };

    case 'eof':
    case 'new':
      return { kind: 'done', outcome: { kind: 'new' } };

    case 'escape':
      return { kind: 'done', outcome: { kind: 'abort' } };

    case 'up':
      return { kind: 'state', state: { ...state, cursor: clamp(state.cursor - 1), notice: null } };

    case 'down':
      return { kind: 'state', state: { ...state, cursor: clamp(state.cursor + 1), notice: null } };

    case 'page-up':
      return { kind: 'state', state: { ...state, cursor: clamp(state.cursor - Math.max(1, pageSize)), notice: null } };

    case 'page-down':
      return { kind: 'state', state: { ...state, cursor: clamp(state.cursor + Math.max(1, pageSize)), notice: null } };

    case 'home':
      return { kind: 'state', state: { ...state, cursor: 0, notice: null } };

    case 'end':
      return { kind: 'state', state: { ...state, cursor: clamp(n - 1), notice: null } };

    case 'backspace':
      return { kind: 'state', state: { ...state, digits: state.digits.slice(0, -1), notice: null } };

    case 'char': {
      const ch = key.char ?? '';
      if (/^[0-9]$/.test(ch)) {
        // 数字：累积但不跳转（等 Enter 确认），同时实时移动高亮到该序号
        const digits = (state.digits + ch).slice(0, 4);
        const num = Number(digits);
        if (num >= 1 && num <= n) {
          return { kind: 'state', state: { ...state, digits, cursor: num - 1, notice: null } };
        }
        return { kind: 'state', state: { ...state, digits, notice: null } };
      }
      return { kind: 'state', state };
    }

    case 'enter': {
      // 有数字输入 → 按数字选；否则选当前高亮
      if (state.digits) {
        const num = Number(state.digits);
        if (num >= 1 && num <= n) {
          return { kind: 'done', outcome: { kind: 'picked', id: rows[num - 1].id } };
        }
        return {
          kind: 'state',
          state: { ...state, digits: '', notice: `序号 ${state.digits} 超出范围 1-${n}` },
        };
      }
      if (n === 0) return { kind: 'done', outcome: { kind: 'new' } };
      return { kind: 'done', outcome: { kind: 'picked', id: rows[state.cursor].id } };
    }
  }
  return { kind: 'state', state };
}

/**
 * 让 cursor 始终在视口内 —— 光标带动视口，而不是视口跟随光标。
 *
 * 两者区别：PgUp/PgDn 时视口先动、光标后到；这里做的是「移动后把视口拉回来」，
 * 效果一致但实现更简单（不需要单独跟踪"用户是否在滚视口"）。
 */
export function ensureVisible(state: PickerState, pageSize: number): PickerState {
  const size = Math.max(1, pageSize);
  let top = state.scrollTop;
  if (state.cursor < top) top = state.cursor;
  if (state.cursor >= top + size) top = state.cursor - size + 1;
  // 不越过末尾
  top = Math.max(0, Math.min(top, Math.max(0, state.cursor)));
  return top === state.scrollTop ? state : { ...state, scrollTop: top };
}

// ---------------------------------------------------------------- 布局

export interface Size { columns: number; rows: number }

export interface Layout {
  listRows: number;
  previewRows: number;
  compact: boolean;
  narrow: boolean;
  nameWidth: number;
}

const HEADER_ROWS = 1;
const FOOTER_ROWS = 1;
const PREVIEW_BORDER_ROWS = 1;

export function computeLayout(size: Size, total: number): Layout {
  const columns = Math.max(20, size.columns || 80);
  const rows = Math.max(6, size.rows || 24);
  const compact = rows < 12;
  const narrow = columns < 48;

  // 预览占 1/4 高度，上限 8 行（预览是帮助区分的，不是阅读区）
  const previewRows = compact
    ? 0
    : Math.max(2, Math.min(8, Math.floor((rows - HEADER_ROWS - FOOTER_ROWS - PREVIEW_BORDER_ROWS) / 4)));

  const listRows = Math.max(
    1,
    rows - HEADER_ROWS - FOOTER_ROWS - (previewRows > 0 ? previewRows + PREVIEW_BORDER_ROWS : 0),
  );

  const nameWidth = narrow
    ? Math.max(8, columns - 8)                       // 窄屏只留序号 + 名字
    : Math.min(44, Math.max(24, columns - 28));      // 正常：给时间/条数留 28 列

  return { listRows: Math.min(listRows, Math.max(1, total)), previewRows, compact, narrow, nameWidth };
}

// ---------------------------------------------------------------- 渲染

/** 按显示宽度补空格（中文按 2 列） */
function padWidth(text: string, width: number): string {
  let w = 0;
  for (const ch of text) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w >= width ? text : text + ' '.repeat(width - w);
}

function fitWidth(text: string, width: number): string {
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
    if (w + cw > width) return out + '…';
    out += ch;
    w += cw;
  }
  return out;
}

export interface RenderInput {
  rows: SessionRow[];
  state: PickerState;
  layout: Layout;
  lastId: string | null;
  preview: PreviewBlock[];
  now?: number;
}

/** 生成整帧文本（不含 ANSI 定位码，由调用方负责上移/清屏） */
export function renderFrame(input: RenderInput): string {
  const { rows, state, layout, lastId, preview } = input;
  const now = input.now ?? Date.now();
  const lines: string[] = [];

  // ---- header ----
  const hint = layout.narrow
    ? `会话 ${rows.length} 个`
    : `可用会话（${rows.length} 个） · ↑↓ 移动  Enter 恢复  n 新会话  q 退出`;
  lines.push(hint);

  // ---- list ----
  const total = rows.length;
  const numWidth = String(total).length;
  const visible = rows.slice(state.scrollTop, state.scrollTop + layout.listRows);

  if (total === 0) {
    lines.push('  （没有可恢复的会话）');
  } else {
    for (let i = 0; i < visible.length; i++) {
      const abs = state.scrollTop + i;
      const r = visible[i];
      const selected = abs === state.cursor;
      const arrow = selected ? '▸' : ' ';
      const num = String(abs + 1).padStart(numWidth, ' ');
      const name = fitWidth(r.id, layout.nameWidth);

      let tail = '';
      if (!layout.narrow) {
        const rel = formatRelative(r.startedAt ?? parseStartedAtFromId(r.id), now);
        tail = `  ${padWidth(rel, 8)}  ${String(r.messages).padStart(3, ' ')} 条`;
      }
      const lastMark = lastId && r.id === lastId ? ' ←上次' : '';
      const row = `${arrow} ${num}. ${padWidth(name, layout.nameWidth)}${tail}${lastMark}`;
      lines.push(selected ? `\x1b[7m${row}\x1b[0m` : row);
    }
    // 补齐到 listRows，避免残余行残留
    for (let i = visible.length; i < layout.listRows; i++) lines.push('');
  }

  // ---- preview ----
  if (layout.previewRows > 0) {
    const cur = rows[state.cursor];
    const title = cur ? `预览 · ${cur.id}` : '预览';
    lines.push(`\x1b[2m${fitWidth(`── ${title} `, 200)}\x1b[0m`);
    const shown = preview.slice(-layout.previewRows);
    for (let i = 0; i < layout.previewRows; i++) {
      const b = shown[i];
      lines.push(b ? `\x1b[2m${fitWidth(b.prefix + b.text, 200)}\x1b[0m` : '');
    }
  }

  // ---- footer ----
  const pos = total === 0 ? '0/0' : `${state.cursor + 1}/${total}`;
  const notice = state.notice ? `  \x1b[33m${state.notice}\x1b[0m` : '';
  const digits = state.digits ? `  输入：${state.digits}` : '';
  lines.push(`\x1b[2m${pos}\x1b[0m${digits}${notice}`);

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- I/O 接线

export interface PickerIO2 {
  stdin: {
    isTTY?: boolean;
    setRawMode?(mode: boolean): unknown;
    on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
    off?(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
    removeListener?(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
    resume?(): void;
    pause?(): void;
  };
  stdout: {
    columns?: number;
    rows?: number;
    write(text: string): unknown;
  };
}

export interface InteractiveOpts {
  /** 取某个会话的预览内容；返回 null 表示读取失败（预览留空） */
  loadPreview: (id: string) => PreviewBlock[] | null;
  now?: number;
}

/**
 * 跑交互式选择器。调用方负责判断 isTTY（非 TTY 应走 session_picker.ts 的行读取）。
 */
export function pickSessionInteractive(
  io: PickerIO2,
  rows: SessionRow[],
  lastId: string | null,
  opts: InteractiveOpts,
): Promise<PickOutcome> {
  return new Promise<PickOutcome>(resolve => {
    const stdin = io.stdin;
    const stdout = io.stdout;
    const layout = computeLayout(
      { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 },
      rows.length,
    );

    let state = ensureVisible(initialState(rows, lastId), layout.listRows);
    let pending = '';
    let escTimer: ReturnType<typeof setTimeout> | null = null;
    let drawnRows = 0;
    let finished = false;

    // 预览缓存：7MB 的 session.json 全量 parse 约 50~100ms，
    // 方向键连按若不缓存会明显卡顿。
    const cache = new Map<number, PreviewBlock[]>();
    const previewFor = (idx: number): PreviewBlock[] => {
      const cached = cache.get(idx);
      if (cached) return cached;
      const row = rows[idx];
      if (!row) return [];
      let blocks: PreviewBlock[] = [];
      try {
        blocks = opts.loadPreview(row.id) ?? [];
      } catch { blocks = []; }
      cache.set(idx, blocks);
      return blocks;
    };

    const draw = (): void => {
      const frame = renderFrame({
        rows, state, layout, lastId,
        preview: previewFor(state.cursor),
        now: opts.now,
      });
      // 后续帧：上移上次行数 + 清到屏末（不用 \x1b[2J，那会清掉用户此前的滚动历史）
      const prefix = drawnRows > 0 ? `\x1b[${drawnRows}A\r\x1b[J` : '';
      stdout.write(prefix + frame);
      drawnRows = frame.split('\n').length - 1;
    };

    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      if (escTimer) { clearTimeout(escTimer); escTimer = null; }
      const off = stdin.off ?? stdin.removeListener;
      if (off) off.call(stdin, 'data', onData);
      try { stdin.setRawMode?.(false); } catch { /* 忽略 */ }
      try { stdin.pause?.(); } catch { /* 忽略 */ }
      // 复位属性 + 恢复光标（万一被隐藏）；换行让后续输出从新行开始
      stdout.write('\x1b[0m\x1b[?25h\n');
    };

    const finish = (outcome: PickOutcome): void => {
      cleanup();
      resolve(outcome);
    };

    const handle = (key: ParsedKey): void => {
      const res = applyKey(state, key, rows, layout.listRows);
      if (res.kind === 'done') { finish(res.outcome); return; }
      state = ensureVisible(res.state, layout.listRows);
      draw();
    };

    const onData = (chunk: string | Buffer): void => {
      if (finished) return;
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      // Ctrl 组合不必等累积
      if (pending.includes('\x03')) { finish({ kind: 'abort' }); return; }
      if (pending.includes('\x04')) { finish({ kind: 'new' }); return; }

      const key = parseKey(pending);
      if (key === null) {
        // 半截转义序列：等后续字节。但没有后续就是 Esc 键本身。
        if (escTimer) clearTimeout(escTimer);
        escTimer = setTimeout(() => {
          escTimer = null;
          const buffered = pending;
          pending = '';
          if (buffered === '\x1b') { finish({ kind: 'abort' }); return; }
          // 其它无法识别的残片：丢弃
          handle({ name: 'ignore' });
        }, ESC_TIMEOUT_MS);
        return;
      }

      if (escTimer) { clearTimeout(escTimer); escTimer = null; }
      pending = '';
      handle(key);
    };

    try {
      stdin.setRawMode?.(true);
    } catch { /* 非 TTY 时忽略；调用方本应先判断 */ }
    stdin.on('data', onData);
    stdin.resume?.();
    draw();
  });
}
