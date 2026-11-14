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

/**
 * 状态行内容。时间**不**在这里 —— 这里只有「何时开始」，
 * 由渲染层用 `now - startedAt` 现算，这样 agent 卡住时秒数照涨。
 */
export interface StatusView {
  main: string;
  detail: string;
  /** 本阶段开始时刻 —— 唯一时间源，时间由渲染层现算 */
  startedAt: number;
}

export interface TuiState {
  log: LogItem[];
  input: string;
  cursor: number;
  busy: boolean;
  waiting: boolean;
  status: StatusView | null;
  /**
   * 已提交、尚未开始的指令（FIFO）。
   *
   * 为什么需要：`waiting` 只表示「主循环是否阻塞在 readLine 上」，但输入能力
   * 不应跟着它走 —— agent 跑一轮动辄几十秒，用户此刻恰好最有空说话。
   * 所以运行中打字不再被丢弃，按 Enter 入队，当前轮结束后由 readLine() 取队首。
   */
  queue: string[];
}

const EMPTY: TuiState = {
  log: [],
  input: '',
  cursor: 0,
  busy: false,
  waiting: false,
  status: null,
  queue: [],
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
   * 中断的语义是「停止一切在途工作」，所以队列也一并取消 —— 否则用户按了 Esc，
   * 下一轮的排队指令立刻接上跑，看起来就像中断失效。
   * 但「取消」不等于「销毁」：入队时已写进 history，`↑` 一次就能召回重发。
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
      const dropped = this.clearQueue();
      if (dropped > 0) {
        this.append('system', `⏹ 队列中 ${dropped} 条已取消（按 ↑ 可找回）`);
      }
    }
    return handled;
  }

  /**
   * 清空待发送队列（Ctrl+X）。
   *
   * 提供这个出口是因为：运行中想重写队列，否则只能「中断 → 重打」，
   * 而中断会连带打断正在做的事。取消的条目仍在 history 里，`↑` 可召回。
   *
   * @returns 清掉的条数
   */
  clearQueue(): number {
    const n = this.state.queue.length;
    if (n > 0) this.update({ queue: [] });
    return n;
  }

  /** 是否正在执行一轮（waiting=false 且非退出态） */
  isRunning(): boolean {
    return !this.state.waiting;
  }

  setStatus(status: StatusView | null): void {
    this.update({ status });
  }

  /**
   * 主循环调用：等待用户提交一行。
   *
   * **队列优先**：上一轮运行期间排队的指令在这里被消费，用户不需要再按一次回车。
   * 把「队列」藏在 readLine() 内部，主循环的 `while(true)` 与 6 个 continue 分支
   * 一行都不用改 —— 复杂度留在唯一入口，比在每个分支加判断可靠得多。
   */
  readLine(): Promise<string> {
    this.historyIdx = -1;
    const next = this.state.queue[0];
    if (next !== undefined) {
      this.update({ queue: this.state.queue.slice(1), waiting: false, status: null });
      // 真正出队时才写日志。入队时不写：中断会清空队列，而 <Static> 已打印的行
      // 无法回改，日志里留下「说过但从未被处理」的消息比少一行更失真。
      this.appendBlock('user', next);
      return Promise.resolve(next);
    }
    this.update({ waiting: true, status: null });
    return new Promise(resolve => { this.resolveLine = resolve; });
  }

  /** 提交当前输入（回车）：空闲时直接投递，运行中入队 */
  submit(): void {
    const text = this.state.input;
    if (!text.trim()) return;

    // 先进历史：中断取消队列时靠 ↑ 找回，这条不能省
    this.history.push(text);
    this.historyIdx = -1;

    if (this.resolveLine) {
      const resolve = this.resolveLine;
      // 先摘掉 resolveLine：即使下面渲染抛异常，也不会出现「await 被两份 resolve」。
      this.resolveLine = null;
      try {
        this.update({ waiting: false, input: '', cursor: 0, status: null });
        this.appendBlock('user', text);
      } finally {
        // ⚠️ resolve 必须无条件执行：它是主循环 `await cli.readLine()` 的唯一唤醒源。
        // 渲染/日志抛异常时若不 resolve，主循环就永久挂起，waiting 停在 false，
        // 表现为「终端还能动但打不了字」（与主循环逃逸是同一个症状）。
        resolve(text);
      }
      return;
    }

    // 运行中（或恰好处于 readLine 返回后的极短窗口）：入队，等下一个人 readLine() 取走
    this.update({ input: '', cursor: 0, status: null, queue: [...this.state.queue, text] });
  }

  // ---- 行编辑 ----

  /**
   * 是否可以编辑输入行。
   *
   * 改前是 `waiting && resolveLine != null` —— 运行中输入框整个被卸载。
   * 现在运行中也要能打字（入队），所以闸门只看「有没有正在收单的 readLine」，
   * 不再看主循环忙不忙。
   */
  private editing(): boolean {
    return this.state.waiting ? this.resolveLine != null : true;
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
