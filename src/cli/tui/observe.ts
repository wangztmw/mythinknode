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

/*
 * 注：这里曾有 viewStatus() / StatusView —— 把快照翻译成「带 warning 的一行文字」。
 * 已删除，原因有二：
 *   1) 它是死代码：真正用的适配在 cli/tui/session.tsx
 *   2) 它的 warning 是硬编码阈值策略（3s「仍在进行」/15s「可能卡住」），
 *      而「状态不变」既可能是 sleep 30（正常）也可能是死锁，信号没有区分力。
 *      秒数本身已经把「过了多久」说清楚了（见 Plan/20261114-1636-tui-ux-polish/）。
 */
