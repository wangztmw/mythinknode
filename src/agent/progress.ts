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

export interface MergedTool {
  name: string;
  count: number;
  inputs: string[];
  lines: number;
  sample: string;
}

export type ProgressEvent =
  | { type: 'thinking_start'; label: string; time: number }
  | { type: 'thinking_tick'; label: string; elapsedMs: number }
  | { type: 'thinking_end'; label: string; elapsedMs: number; toolCount: number; time: number }
  | { type: 'tool_display'; calls: MergedTool[]; elapsedMs?: number }
  | { type: 'thought'; text: string }
  | { type: 'error'; message: string };
