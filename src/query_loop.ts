/**
 * Query 循环 — agentLoop() 一份代码驱动主Agent和子Agent
 *
 * 主Agent 和子Agent 的区别全在 AgentLoopParams 配置中。
 */
import { AgentEngine } from './agent/agent_def.js';
import type { ProgressEvent, MergedTool } from './cli/monitor/progress.js';
import type { ChatMessage } from './llm/types.js';

export interface LoopResult {
  status: 'success' | 'blocked' | 'killed' | 'crashed' | 'max_rounds';
  text: string;
  blockedReason?: string;
  roundCount: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentLoopParams {
  messages: ChatMessage[];
  maxRounds: number;
  onTurnComplete?: (messages: ChatMessage[], toolCount: number) => void;
  onComplete?: (text: string) => void;
  preRoundCheck?: (messages: ChatMessage[]) => string | null;
  updateStats?: (name: string, summary: string, output: string, feedback?: string) => void;
  phaseLabel?: (i: number, lastMsg: unknown) => string;
  serialTools?: boolean;
  systemPrompt?: string;
}

// ---- 辅助函数 ----

function extractText(response: any): string {
  return (response.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text').map(b => b.text || '').join('\n');
}

function countToolUses(response: any): number {
  return (response.content as Array<{ type: string }>)
    .filter(b => b.type === 'tool_use').length;
}

function extractThoughts(response: any): string {
  return (response.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text').map(b => b.text || '').join(' ').trim();
}

async function executeTools(
  engine: AgentEngine,
  response: any,
  updateStats?: (name: string, summary: string, output: string, feedback?: string) => void,
  serial?: boolean,
): Promise<Array<{ name: string; id: string; input: Record<string, unknown>; output: string }>> {
  const toolUses = (response.content as any[])
    .filter((b: any) => b.type === 'tool_use' && b.name && b.id);
  const toolMap = engine.toolMap;
  const toolContext = engine.toolContext;
  const TOOL_TIMEOUT_MS = 30_000;

  const executeOne = async (b: any) => {
    const tool = toolMap.get(b.name!);
    let output = '';
    let timedOut = false;
    if (tool) {
      try {
        const r = await Promise.race([
          tool.call(b.input || {}, toolContext),
          new Promise<{ data: string; _timeout: boolean }>((resolve) =>
            setTimeout(() => resolve({
              data: `(tool "${b.name!}" still running after ${TOOL_TIMEOUT_MS / 1000}s — agent will check next round)`,
              _timeout: true,
            }), TOOL_TIMEOUT_MS)
          ),
        ]);
        output = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        timedOut = !!(r as any)._timeout;
      } catch (e) { output = `Error: ${(e as Error).message}`; }
    } else { output = `Unknown tool: ${b.name}`; }
    if (updateStats) {
      const summary = tool?.getToolUseSummary?.(b.input || {}) || b.name!;
      if (timedOut) {
        updateStats(b.name!, summary, output, `BLOCKED: ${b.name!} running for ${TOOL_TIMEOUT_MS / 1000}s`);
      } else {
        updateStats(b.name!, summary, output);
      }
    }
    return { name: b.name!, id: b.id!, input: b.input || {}, output };
  };

  // 工具名立刻出字 + 心跳时间
  const toolNames = toolUses.map((b: any) => b.name!).join(', ');
  const toolStart = Date.now();

  // 立刻显示工具名（0s）
  engine.events.push({ type: 'thinking_tick', label: toolNames, elapsedMs: 0 });

  // 心跳定时器（100ms）
  const toolTick = setInterval(() => {
    engine.events.push({ type: 'thinking_tick', label: toolNames, elapsedMs: Date.now() - toolStart });
  }, 100);

  const calls = serial
    ? await toolUses.reduce(async (prev, b) => {
        const acc = await prev;
        acc.push(await executeOne(b));
        return acc;
      }, Promise.resolve([] as any[]))
    : await Promise.all(toolUses.map(executeOne));

  clearInterval(toolTick);
  const elapsed = Date.now() - toolStart;
  engine.events.push({ type: 'tool_display', calls: engine.mergeToolCalls(calls), elapsedMs: elapsed });
  return calls;
}

function pushResults(
  messages: ChatMessage[],
  engine: AgentEngine,
  toolCalls: Array<{ id: string; output: string }>,
): void {
  const toolResults: Array<unknown> = [];
  for (const c of toolCalls) toolResults.push(engine.llm.formatToolResult(c.id, c.output));
  for (const tr of toolResults) messages.push(tr as ChatMessage);
}

// ---- 统一循环 ----

export async function agentLoop(
  engine: AgentEngine,
  params: AgentLoopParams,
): Promise<LoopResult> {
  const { messages, maxRounds, onTurnComplete, onComplete,
          preRoundCheck, updateStats, phaseLabel, serialTools } = params;
  let inputTokens = 0;
  let outputTokens = 0;

  for (let i = 0; i < maxRounds; i++) {
    if (preRoundCheck) {
      const signal = preRoundCheck(messages);
      if (signal) {
        if (signal.startsWith('BLOCKED:') || signal.startsWith('blocked:')) {
          const reason = signal.replace(/^BLOCKED:\s*/i, '');
          onComplete?.('(blocked)');
          return { status: 'blocked', text: `(blocked: ${reason})`, blockedReason: reason, roundCount: i + 1, inputTokens, outputTokens };
        }
        if (signal === '(killed)' || signal.startsWith('killed')) {
          onComplete?.('(killed)');
          return { status: 'killed', text: signal, roundCount: i + 1, inputTokens, outputTokens };
        }
        messages.push({ role: 'user', content: `[SIGNAL] ${signal}` });
      }
    }

    const lastMsg = messages[messages.length - 1]?.content;
    const phase = phaseLabel?.(i, lastMsg) ?? 'processing';

    let response: { content: Array<unknown>; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } };
    try {
      const thinkStart = Date.now();
      const phase = phaseLabel?.(i, messages[messages.length - 1]?.content) ?? 'processing';
      engine.events.push({ type: 'thinking_start', label: phase, time: thinkStart });

      // 心跳：每 100ms 推一个 tick，CLI 渲染动态时间
      const tick = setInterval(() => {
        engine.events.push({ type: 'thinking_tick', label: phase, elapsedMs: Date.now() - thinkStart });
      }, 100);

      try {
        response = await engine.llm.chat(messages, params.systemPrompt || engine.systemPrompt);
        if (response.usage) {
          inputTokens += response.usage.input_tokens;
          outputTokens += response.usage.output_tokens;
        }
      } finally {
        clearInterval(tick);
      }

      const elapsedMs = Date.now() - thinkStart;
      const toolCount = (response.content as Array<{ type: string }>).filter(b => b.type === 'tool_use').length;
      engine.events.push({ type: 'thinking_end', label: phase, elapsedMs, toolCount, time: Date.now() });
    } catch (e) {
      const errMsg = (e as Error).message || String(e);
      return { status: 'crashed', text: `LLM call failed: ${errMsg}`, roundCount: i + 1, inputTokens, outputTokens };
    }

    if (response.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: response.content });
      const text = extractText(response);
      const tc = countToolUses(response);
      onTurnComplete?.(messages, tc);
      onComplete?.(text);
      return { status: 'success', text: text || '(done)', roundCount: i + 1, inputTokens, outputTokens };
    }

    if (response.stop_reason === 'tool_use') {
      const thoughts = extractThoughts(response);
      if (thoughts) engine.events.push({ type: 'thought', text: thoughts });
      messages.push({ role: 'assistant', content: response.content });

      let feedback: string | undefined;
      if (thoughts) {
        const fm = thoughts.match(/\[FEEDBACK:\s*(.+?)\]/);
        const bm = thoughts.match(/\[BLOCKED:\s*(.+?)\]/);
        if (bm) feedback = `BLOCKED: ${bm[1]}`;
        else if (fm) feedback = fm[1];
      }

      const toolResults = await executeTools(engine, response,
        (n, s, o, f) => updateStats?.(n, s, o, f || feedback || undefined), serialTools);
      pushResults(messages, engine, toolResults);
    } else {
      return { status: 'crashed', text: `Unexpected stop_reason: ${response.stop_reason}`, roundCount: i + 1, inputTokens, outputTokens };
    }
  }
  return { status: 'max_rounds', text: '(max iterations)', roundCount: maxRounds, inputTokens, outputTokens };
}
