/**
 * ProgressEvent — 引擎 → UI 的渲染数据契约。
 *
 * 引擎只管 push（emit），前端（CLI/Web）只管消费。换前端时只需重新消费同一份契约。
 * 放在 agent/ 而非 cli/，让引擎不再依赖 cli 命名空间。
 */
export interface ToolCall {
  name: string;
  id: string;
  input: Record<string, unknown>;
  output: string;
}

export interface ToolPreview {
  /** 已按逻辑行/字符上限截断的预览文本（不含 ANSI 清洗，前端自行处理） */
  text: string;
  /** 原始输出的逻辑总行数 */
  totalLines: number;
  /** preview 中包含的逻辑行数 */
  shownLines: number;
  /** 是否因行数/字符上限被截断 */
  truncated: boolean;
}

export interface MergedTool {
  name: string;
  count: number;
  inputs: string[];
  lines: number;
  sample: string;
  /** 单次调用时的富预览；合并调用（count > 1）时不存在 */
  preview?: ToolPreview;
}

export type ProgressEvent =
  /**
   * ★ 已移除 thinking_start / thinking_tick。
   *   「当前在 thinking、从何时开始、第几轮」属于**状态**，不是事件 ——
   *   已迁到 RuntimeState（agent/runtime_state.ts），由观察者按需采样并自己算 elapsed。
   *   原因：每秒 emit 一次是为了让屏幕上的秒数跳动，等于让 agent 为 UI 刷新率服务；
   *   而且 agent 一旦卡住，最后那个数字会冻结在屏幕上伪装成实时数据。
   */
  | { type: 'thinking_end'; label: string; elapsedMs: number; toolCount: number; time: number }
  | { type: 'tool_display'; calls: MergedTool[]; elapsedMs?: number }
  | { type: 'thought'; text: string }
  /** 循环自检提示（预算续期 / 检测到无进展） */
  | { type: 'notice'; kind: 'budget' | 'no-progress'; text: string }
  | { type: 'error'; message: string };
