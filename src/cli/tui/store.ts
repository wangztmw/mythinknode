/**
 * 交互式 TUI 的外部状态存储。
 *
 * 主循环是 pull 模型（await readLine），React 是 push 模型；
 * 这里用一个小型可订阅 store 作为桥：主循环/引擎事件写入 store，
 * Ink 组件通过 useSyncExternalStore 订阅渲染。
 */
export type LogKind =
  | 'welcome'
  | 'user'
  | 'md'
  | 'system'
  | 'error'
  | 'thought'
  | 'tool'
  | 'toolResult'
  | 'help';

export type LogMeta = Record<string, string | number | boolean>;

export interface LogItem {
  id: number;
  kind: LogKind;
  text: string;
  meta?: LogMeta;
}

export interface TuiState {
  log: LogItem[];
  input: string;
  cursor: number;
  busy: boolean;
  waiting: boolean;
  status: string | null;
}

const EMPTY: TuiState = {
  log: [],
  input: '',
  cursor: 0,
  busy: false,
  waiting: false,
  status: null,
};

export class TuiStore {
  private state: TuiState = EMPTY;
  private listeners = new Set<() => void>();
  private nextId = 1;
  private resolveLine: ((value: string) => void) | null = null;
  private history: string[] = [];
  private historyIdx = -1;
  private historyDraft = '';

  /** Ctrl+C / close() 时由工厂注入：卸载 Ink 并退出进程 */
  onExit: (() => void) | null = null;

  /**
   * 运行期中断处理器（由主循环在一轮开始时注册）。
   * 返回 true = 已接管（打断成功），false = 没有可打断的目标。
   */
  interruptHandler: (() => boolean) | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TuiState => this.state;

  private update(partial: Partial<TuiState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  /** 追加日志（按行拆分，空尾行丢弃） */
  append(kind: LogKind, text: string): void {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) return;
    const items = lines.map(line => ({ id: this.nextId++, kind, text: line }));
    this.update({ log: [...this.state.log, ...items] });
  }

  /** 整块追加（保留换行，供 markdown / 多行用户输入渲染；meta-only 条目允许空正文） */
  appendBlock(kind: LogKind, text: string, meta?: LogMeta): void {
    if (!text && !meta) return;
    const item: LogItem = { id: this.nextId++, kind, text, meta };
    this.update({ log: [...this.state.log, item] });
  }

  /** 批量追加：一次数组复制、一次订阅通知（工具事件会同时产生多块） */
  appendBatch(items: Array<{ kind: LogKind; text: string; meta?: LogMeta }>): void {
    if (items.length === 0) return;
    const next = items.map(item => ({
      id: this.nextId++,
      kind: item.kind,
      text: item.text,
      meta: item.meta,
    }));
    this.update({ log: [...this.state.log, ...next] });
  }

  /** 欢迎框（启动时一次，允许空正文，靠 meta 渲染） */
  appendWelcome(meta: LogMeta): void {
    const item: LogItem = { id: this.nextId++, kind: 'welcome', text: '', meta };
    this.update({ log: [...this.state.log, item] });
  }

  setBusy(busy: boolean): void {
    this.update({ busy, status: busy ? this.state.status : null });
  }

  /**
   * 请求中断当前行动（Esc / 运行中 Ctrl+C）。
   *
   * @returns true = 有正在执行的一轮被打断；false = 当前空闲（调用方应走退出路径）
   */
  requestInterrupt(): boolean {
    if (!this.interruptHandler) return false;
    let handled = false;
    try {
      handled = this.interruptHandler();
    } catch { return false; }
    if (handled) {
      // 给用户即时反馈：按键是有响应的，不是没反应
      this.append('system', '⏹ 正在中断当前行动…');
    }
    return handled;
  }

  /** 是否正在执行一轮（waiting=false 且非退出态） */
  isRunning(): boolean {
    return !this.state.waiting;
  }

  setStatus(status: string | null): void {
    this.update({ status });
  }

  /** 主循环调用：等待用户提交一行 */
  readLine(): Promise<string> {
    this.historyIdx = -1;
    this.update({ waiting: true, status: null });
    return new Promise(resolve => { this.resolveLine = resolve; });
  }

  /** 提交当前输入（回车） */
  submit(): void {
    const text = this.state.input;
    if (!text.trim() || !this.resolveLine) return;
    const resolve = this.resolveLine;
    // 先摘掉 resolveLine：即使下面渲染抛异常，也不会出现「await 被两份 resolve」。
    this.resolveLine = null;
    try {
      this.history.push(text);
      this.historyIdx = -1;
      this.update({ waiting: false, input: '', cursor: 0, status: null });
      this.appendBlock('user', text);
    } finally {
      // ⚠️ resolve 必须无条件执行：它是主循环 `await cli.readLine()` 的唯一唤醒源。
      // 渲染/日志抛异常时若不 resolve，主循环就永久挂起，waiting 停在 false，
      // 表现为「终端还能动但打不了字」（与主循环逃逸是同一个症状）。
      resolve(text);
    }
  }

  // ---- 行编辑 ----

  private editing(): boolean {
    return this.state.waiting && this.resolveLine != null;
  }

  insert(text: string): void {
    if (!this.editing() || !text) return;
    const { input, cursor } = this.state;
    this.update({
      input: input.slice(0, cursor) + text + input.slice(cursor),
      cursor: cursor + text.length,
    });
  }

  backspace(): void {
    if (!this.editing() || this.state.cursor === 0) return;
    const { input, cursor } = this.state;
    this.update({ input: input.slice(0, cursor - 1) + input.slice(cursor), cursor: cursor - 1 });
  }

  deleteForward(): void {
    if (!this.editing() || this.state.cursor >= this.state.input.length) return;
    const { input, cursor } = this.state;
    this.update({ input: input.slice(0, cursor) + input.slice(cursor + 1) });
  }

  moveLeft(): void {
    if (!this.editing()) return;
    this.update({ cursor: Math.max(0, this.state.cursor - 1) });
  }

  moveRight(): void {
    if (!this.editing()) return;
    this.update({ cursor: Math.min(this.state.input.length, this.state.cursor + 1) });
  }

  moveHome(): void {
    if (this.editing()) this.update({ cursor: 0 });
  }

  moveEnd(): void {
    if (this.editing()) this.update({ cursor: this.state.input.length });
  }

  clearLine(): void {
    if (this.editing()) this.update({ input: '', cursor: 0 });
  }

  deleteWord(): void {
    if (!this.editing() || this.state.cursor === 0) return;
    const { input, cursor } = this.state;
    let i = cursor;
    while (i > 0 && input[i - 1] === ' ') i--;
    while (i > 0 && input[i - 1] !== ' ') i--;
    this.update({ input: input.slice(0, i) + input.slice(cursor), cursor: i });
  }

  historyPrev(): void {
    if (!this.editing() || this.history.length === 0) return;
    if (this.historyIdx === -1) {
      this.historyDraft = this.state.input;
      this.historyIdx = this.history.length - 1;
    } else if (this.historyIdx > 0) {
      this.historyIdx--;
    } else {
      return;
    }
    const value = this.history[this.historyIdx];
    this.update({ input: value, cursor: value.length });
  }

  historyNext(): void {
    if (!this.editing() || this.historyIdx === -1) return;
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      const value = this.history[this.historyIdx];
      this.update({ input: value, cursor: value.length });
    } else {
      this.historyIdx = -1;
      const value = this.historyDraft;
      this.update({ input: value, cursor: value.length });
    }
  }

  forceExit(): void {
    this.onExit?.();
  }
}
