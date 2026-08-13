/**
 * ProgressEvent — 引擎 → CLI 的渲染数据合同
 *
 * 引擎只管 push，CLI 只管渲染。换前端时只需要重新消费同样的 ProgressEvent。
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

/** 启动事件轮询。每 80ms 消费事件队列，tick 类型只取最后一条（防止 \r 刷新过于密集导致 Terminal 崩溃）。返回 stop 函数。 */
export function pollEvents(engine: { events: Array<{ type: string; [key: string]: unknown }> }, render: (e: ProgressEvent) => void): () => void {
  const timer = setInterval(() => {
    let lastTick: ProgressEvent | null = null;
    while (engine.events.length > 0) {
      const e = engine.events.shift()! as ProgressEvent;
      if (e.type === 'thinking_tick') {
        lastTick = e; // 只保留最后一条 tick，丢掉前面的
        continue;
      }
      try { render(e); } catch { /* 渲染不应崩 */ }
    }
    if (lastTick) try { render(lastTick); } catch { /* 渲染不应崩 */ }
  }, 80);
  return () => clearInterval(timer);
}
