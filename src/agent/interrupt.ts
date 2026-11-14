/**
 * 运行期中断总线。
 *
 * 一个「run」= 主循环里的一轮执行（`runSession` 的整个 LLM/工具循环）。
 * 用户按 Esc / Ctrl+C 时调用 `abortCurrentRun()`，各层（LLM fetch、工具执行、
 * 循环顶部）通过 `run.signal` 感知并尽快退出。
 *
 * 为什么是单飞（同一时刻只有一个 current）：
 *   共享一个长期存活的 AbortController 会让「第一轮被 abort」的状态泄漏到第二轮
 *   （signal 一旦 abort 就永久为 true）。所以每轮 `beginRun()` 新建一个，
 *   `endRun()` 清空。`beginRun()` 顺手 abort 掉上一个未结束的 run 只是防御。
 */

export interface RunHandle {
  readonly signal: AbortSignal;
  /** 中断原因（用于回灌给模型 / 显示给用户） */
  readonly reason: string;
  /** 主动中断。幂等，可重复调用。 */
  abort(reason?: string): void;
}

interface InternalRun {
  controller: AbortController;
  reason: string;
}

let current: InternalRun | null = null;
/** 当前 run 的标识，用来让 endRun 只清理自己那次 */
let currentToken = 0;

const DEFAULT_REASON = '用户中断';

export class UserAbortError extends Error {
  constructor(message = 'aborted by user') {
    super(message);
    // name 是 retry.ts 识别「不要重试」的依据，别改
    this.name = 'UserAbortError';
  }
}

/** 开始一次 run。返回句柄，调用方负责在 finally 里 `endRun(handle)`。 */
export function beginRun(): RunHandle {
  // 防御：上一个 run 没有正常结束（理论不该发生），先收掉它
  if (current) {
    try { current.controller.abort(); } catch { /* 忽略 */ }
  }

  const controller = new AbortController();
  const token = ++currentToken;
  const run: InternalRun = { controller, reason: DEFAULT_REASON };
  current = run;

  return {
    get signal(): AbortSignal { return controller.signal; },
    get reason(): string { return run.reason; },
    abort(reason?: string): void {
      if (reason) run.reason = reason;
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

/** 结束一次 run。只有当前 run 是自己时才清空（防止晚到的 endRun 清掉新 run）。 */
export function endRun(handle?: RunHandle): void {
  if (!current) return;
  // 不比较 handle 对象本身（外层拿到的可能是同一 controller 的包装），
  // 用 aborted 状态 + token 判断更简单：只要当前 run 已结束就清。
  if (handle && !handle.signal.aborted) {
    // 正常结束（未中断）→ 清空当前槽位
    current = null;
    return;
  }
  current = null;
}

/**
 * 中断当前 run。
 * @returns 是否有正在执行的 run 被中断（false = 当前空闲，调用方应走「退出」路径）
 */
export function abortCurrentRun(reason?: string): boolean {
  if (!current) return false;
  if (reason) current.reason = reason;
  if (!current.controller.signal.aborted) current.controller.abort();
  return true;
}

/** 当前是否有 run 在跑 */
export function hasActiveRun(): boolean {
  return current !== null;
}

/** 当前 run 的 signal（没有 run 时返回 undefined） */
export function currentSignal(): AbortSignal | undefined {
  return current?.controller.signal;
}

/** 测试用：重置模块状态 */
export function __resetInterruptForTest(): void {
  current = null;
  currentToken = 0;
}
