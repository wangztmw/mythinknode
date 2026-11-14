/**
 * 观察者采样器 —— 「眼睛」。
 *
 * ★ 这是**观察者**侧的代码，属于 UI 层，不属于 agent。
 *   agent 不知道它在被看，也不为它做任何事（不再每秒 emit 进度）。
 *
 * 为什么是 pull：
 *   - agent 只提供 `snapshot()`（当前在做什么、从何时开始），不提供「已经过了多久」
 *   - 这里按固定节奏采样，elapsed 由渲染层用 `now - startedAt` 现算
 *   - 于是 agent 卡住时数字照涨 → 卡顿可见，而不是冻结成假象
 *
 * 只有「状态真的变了」才通知订阅者（lastKey 比对）。
 * 时间流逝本身不触发任何重绘 —— 渲染层自带 1s 的重绘节奏即可。
 */
import type { RuntimeState } from '../../agent/runtime_state.js';

/** 采样器看到一帧时的附加信息（observation 侧才有，agent 不知道） */
export interface Observation {
  state: RuntimeState;
  /** 采样时刻 */
  now: number;
  /** 距上次状态**变化**过了多久（用于「疑似卡住」判断） */
  sinceChangeMs: number;
}

export interface Sampler {
  subscribe(listener: (obs: Observation) => void): () => void;
  /** 立刻采一帧（订阅者会收到，即便状态没变） */
  poke(): void;
  dispose(): void;
}

/** 采样间隔：足够发现状态变化，又不至于空转 */
const SAMPLE_INTERVAL_MS = 120;

/** 状态指纹 —— 只有它变了才通知。刻意不含任何时间字段。 */
function stateKey(s: RuntimeState): string {
  return [
    s.phase,
    s.round,
    s.label,
    s.tool?.name ?? '',
    s.subAgents.map(a => a.id).join(','),
    s.tokens.input,
    s.tokens.output,
  ].join('|');
}

export function createSampler(
  engine: { snapshot(): RuntimeState },
  intervalMs = SAMPLE_INTERVAL_MS,
): Sampler {
  const listeners = new Set<(obs: Observation) => void>();
  let lastKey = '';
  let lastChangeAt = Date.now();
  let disposed = false;

  const emit = (force: boolean) => {
    if (disposed) return;
    const state = engine.snapshot();
    const key = stateKey(state);
    const now = Date.now();
    if (key !== lastKey) {
      lastKey = key;
      lastChangeAt = now;
    } else if (!force) {
      return; // 状态没变，不打扰订阅者（渲染层自己负责让秒数动）
    }
    for (const l of listeners) {
      try { l({ state, now, sinceChangeMs: now - lastChangeAt }); } catch { /* 观察者不能拖垮主体 */ }
    }
  };

  const timer = setInterval(() => emit(false), intervalMs);

  return {
    subscribe(listener) {
      listeners.add(listener);
      // 订阅时立刻给一帧，避免订阅晚于第一次状态变化时空白
      try { listener({ state: engine.snapshot(), now: Date.now(), sinceChangeMs: 0 }); } catch { /* 忽略 */ }
      return () => { listeners.delete(listener); };
    },
    poke() { emit(true); },
    dispose() {
      disposed = true;
      clearInterval(timer);
      listeners.clear();
    },
  };
}

/**
 * 把快照翻译成给用户看的一行文字。
 *
 * 时间在这里算 —— `now - startedAt`，不是从 agent 拿的过期数字。
 * 这是整个 pull 模型的关键点：**时间语义归观察者所有**。
 */
export interface StatusView {
  /** 主文案，如 "Thinking"、"Bash" */
  main: string;
  /** 阶段说明，如 "analyzing"、"reviewing results" */
  detail: string;
  /** 已过秒数（1 位小数） */
  elapsedSec: number;
  /** 观察者自己判断的异常提示（agent 完全不知道这个逻辑存在） */
  warning: string | null;
}

/** 「疑似卡住」阈值 —— 观察者侧的策略，与 agent 无关 */
const SLOW_HINT_MS = 3_000;
const STUCK_HINT_MS = 30_000;

export function viewStatus(obs: Observation): StatusView | null {
  const { state, now, sinceChangeMs } = obs;
  if (state.phase === 'idle') return null;

  const startedAt = state.tool?.startedAt ?? state.phaseStartedAt;
  const elapsedMs = Math.max(0, now - startedAt);
  const isThinking = state.phase === 'thinking';

  // thinking 阶段的 label 是 'analyzing' 之类；executing 阶段的 label 就是工具名
  const main = isThinking ? 'Thinking' : (state.tool?.name ?? state.label);
  const detail = isThinking ? state.label : '';

  let warning: string | null = null;
  if (sinceChangeMs >= STUCK_HINT_MS) warning = `⚠ 已 ${Math.round(sinceChangeMs / 1000)}s 无变化，可能卡住`;
  else if (elapsedMs >= SLOW_HINT_MS) warning = '仍在进行…';

  return {
    main,
    detail,
    elapsedSec: elapsedMs / 1000,
    warning,
  };
}
