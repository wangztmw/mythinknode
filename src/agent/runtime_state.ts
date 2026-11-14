/**
 * RuntimeState — 被观察者的「当前样貌」快照。
 *
 * ★ 设计原则：agent 只写「事实」（何时进入什么阶段、在跑什么工具），
 *   绝不写「已经过了多久」。elapsed 是**观察者**在渲染时现算的派生值。
 *
 * 为什么不用事件推送 elapsed：
 *   - 事件推送会让 agent 为 UI 刷新率服务（每秒 emit 一次，45 分钟 = 2700 次纯 UI 事件）
 *   - 更重要的是：一旦 agent 卡住/被阻塞，最后那个数字会**冻结**在屏幕上，
 *     用户看到的是「过了 4 秒」而不是「已经 40 秒没动了」 —— 过期数字伪装成实时数据。
 *   - 观察者自己算 `now - startedAt`，agent 卡住数字也照涨，卡顿立刻可见。
 *
 * 见 Plan/20261114-1518-observer-pull-model/plan.md 与 lessons/L26。
 */

export type RuntimePhase =
  /** 空闲，等用户输入 */
  | 'idle'
  /** 等 LLM 返回 */
  | 'thinking'
  /** 执行工具 */
  | 'executing';

export interface RuntimeToolState {
  /** 工具名，如 'Bash'、'Bash, Read' */
  name: string;
  /** 该工具开始执行的时刻 */
  startedAt: number;
}

export interface RuntimeSubAgent {
  id: string;
  subject: string;
  status: string;
  startedAt: number;
}

export interface RuntimeState {
  phase: RuntimePhase;
  /** 当前阶段开始的时刻（唯一时间源） */
  phaseStartedAt: number;
  /** 阶段说明，如 'analyzing'、'reviewing results' */
  label: string;
  /** 第几轮（从 0 开始） */
  round: number;
  /** executing 阶段才有 */
  tool?: RuntimeToolState;
  /** 并行/后台子 agent */
  subAgents: RuntimeSubAgent[];
  tokens: { input: number; output: number };
}

/** 空闲态快照 —— 也用于「一轮结束」复位 */
export function idleState(): RuntimeState {
  return {
    phase: 'idle',
    phaseStartedAt: Date.now(),
    label: '',
    round: 0,
    subAgents: [],
    tokens: { input: 0, output: 0 },
  };
}
