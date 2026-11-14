/**
 * Query 循环 — agentLoop() 一份代码驱动主Agent和子Agent
 *
 * 主Agent 和子Agent 的区别全在 AgentLoopParams 配置中。
 */
import { AgentEngine } from './agent/agent_def.js';
import type { ProgressEvent, MergedTool } from './agent/progress.js';
import type { ChatMessage } from './llm/types.js';

export interface LoopResult {
  status: 'success' | 'blocked' | 'killed' | 'crashed' | 'max_rounds';
  text: string;
  blockedReason?: string;
  roundCount: number;
  /** 软预算续期次数（撞 maxRounds 后由模型自行决定继续了几次） */
  extensions?: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentLoopParams {
  messages: ChatMessage[];
  /** 单次软预算（一轮 grant 的轮数）。撞到后交给模型自行判断是否续期 */
  maxRounds: number;
  /** 最多续期几次，默认 3 → 实际上限 maxRounds * (1 + maxRounds*maxExtensions) */
  maxExtensions?: number;
  /** 绝对上限（轮），默认 maxRounds * (1 + maxExtensions) */
  hardRounds?: number;
  /** 墙钟上限 ms，0 = 关闭。默认 45 分钟 */
  wallClockMs?: number;
  /** token 预算（in+out），0 = 关闭。默认关闭 */
  tokenBudget?: number;
  /** 连续相同工具调用+相同输出达到该轮数 → 提醒模型（默认 3） */
  noProgressWarn?: number;
  /** 连续相同工具调用+相同输出达到该轮数 → 强制停（默认 6） */
  noProgressStop?: number;
  onTurnComplete?: (messages: ChatMessage[], toolCount: number) => void;
  onComplete?: (text: string) => void;
  preRoundCheck?: (messages: ChatMessage[]) => string | null;
  updateStats?: (name: string, summary: string, output: string, feedback?: string) => void;
  phaseLabel?: (i: number, lastMsg: unknown) => string;
  serialTools?: boolean;
  systemPrompt?: string;
  silent?: boolean;
  onRound?: (i: number) => void;
  /** 用户中断信号（Esc / Ctrl+C）。abort 后本函数尽快返回 status='killed'。 */
  signal?: AbortSignal;
}

// ---- 辅助函数 ----

/** 中断时给用户看的一句话（经 renderResult 显示，不依赖渲染层时序） */
const INTERRUPTED_TEXT = '⏹ 已中断当前行动（会话已保留，可直接继续对话）';

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

// ---- 无进展检测 ----

/** 稳定序列化（key 排序），用于给工具参数算指纹 */
function stableStringify(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** FNV-1a 32 位，够用且不占内存 */
function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * 一轮的指纹：工具名 + 参数 + 输出。三者全同才算「无进展」——
 * 只比参数会把「轮询等后台 Agent」误判成卡死（输出在变就是有进展）。
 */
function roundFingerprint(calls: Array<{ name: string; input: Record<string, unknown>; output: string }>): string {
  const callPart = calls.map(c => `${c.name}:${stableStringify(c.input)}`).join('|');
  const outPart = calls.map(c => c.output).join('|');
  return `${calls.length}|${hashStr(callPart)}|${hashStr(outPart)}`;
}

function budgetNotice(round: number, granted: number, hardRounds: number, left: number): string {
  return `[BUDGET] You have used ${round} rounds (current grant: ${granted}). `
    + `Status check — decide for yourself whether continuing is still productive:\n`
    + `- If the task is finished, blocked, or you are going in circles → STOP now: reply with a final text answer and NO tool calls.\n`
    + `- If more rounds are genuinely needed → just make the next tool call.\n`
    + `Each continuation grants ${granted} more rounds; ${left} continuation(s) left, hard stop at ${hardRounds} rounds.`;
}

function noProgressNotice(streak: number, calls: Array<{ name: string }>): string {
  const names = [...new Set(calls.map(c => c.name))].join(', ');
  return `[NO PROGRESS] The last ${streak} rounds made the identical tool call(s) with identical results: ${names}.\n`
    + `Repeating this will not change the outcome. Change your approach (different tool, different arguments, `
    + `narrower scope), or stop and report what is blocking you.`;
}

interface ToolExecResult {
  calls: Array<{ name: string; id: string; input: Record<string, unknown>; output: string }>;
  /** 执行过程中发生过用户中断（工具被哨兵提前结束） */
  interrupted: boolean;
}

async function executeTools(
  engine: AgentEngine,
  response: any,
  updateStats?: (name: string, summary: string, output: string, feedback?: string) => void,
  serial?: boolean,
  silent?: boolean,
  signal?: AbortSignal,
): Promise<ToolExecResult> {
  const toolUses = (response.content as any[]).filter((b: any) => b.type === 'tool_use' && b.name && b.id);
  const toolMap = engine.toolMap;
  const toolContext = engine.toolContext;
  const TOOL_TIMEOUT_MS = 30_000;
  /** 工具因用户中断而未执行完成时的填充文本 */
  const INTERRUPTED_TOOL_OUTPUT = '[interrupted] 该工具调用因用户中断而未完成，结果不可用。';
  let interruptedDuringTools = false;

  /** 中断哨兵：让每个工具都能被 signal 提前结束，而不是干等到 30s 超时 */
  const interruptPromise = new Promise<{ data: string; _timeout: boolean; _interrupted: boolean }>((resolve) => {
    if (!signal) return;                     // 没有 signal 就永远不 resolve
    if (signal.aborted) {
      resolve({ data: INTERRUPTED_TOOL_OUTPUT, _timeout: false, _interrupted: true });
      return;
    }
    signal.addEventListener('abort', () => {
      resolve({ data: INTERRUPTED_TOOL_OUTPUT, _timeout: false, _interrupted: true });
    }, { once: true });
  });

  const executeOne = async (b: any) => {
    const tool = toolMap.get(b.name!);
    let output = '';
    let timedOut = false;
    if (signal?.aborted) {
      // 已经被打断：不再发起新工具，直接给一条「未执行」的结果，
      // 保证 tool_use / tool_result 配对完整（否则会话永久 400）。
      output = INTERRUPTED_TOOL_OUTPUT;
      if (updateStats) {
        const summary = tool?.getToolUseSummary?.(b.input || {}) || b.name!;
        updateStats(b.name!, summary, output);
      }
      return { name: b.name!, id: b.id!, input: b.input || {}, output };
    }
    if (b._argError) {
      // 参数不是合法 JSON（openai.ts 容错解析也救不回来）→ 不执行工具，
      // 把错误当成工具结果回灌给模型，让它下一轮重发合法 JSON。
      // 这样一次烂参数只浪费一轮，而不是把整个 agentLoop 打成 crashed。
      output = `Error: tool arguments for "${b.name}" were not valid JSON (${b._argError}). `
        + `Re-emit this tool call with STRICT JSON: double quotes only, no single quotes, no trailing commas, no comments.\n`
        + (b._rawArgs ? `You sent: ${b._rawArgs}` : '');
      if (updateStats) {
        const summary = tool?.getToolUseSummary?.(b.input || {}) || b.name!;
        updateStats(b.name!, summary, output);
      }
      return { name: b.name!, id: b.id!, input: {}, output };
    }
    if (tool) {
      try {
        const r = await Promise.race([
          tool.call(b.input || {}, toolContext),
          // 用户中断：立刻结束等待（工具本身可能还在后台跑，但不能阻塞用户）
          interruptPromise,
          new Promise<{ data: string; _timeout: boolean }>((resolve) =>
            setTimeout(() => resolve({
              data: `(tool "${b.name!}" still running after ${TOOL_TIMEOUT_MS / 1000}s — agent will check next round)`,
              _timeout: true,
            }), TOOL_TIMEOUT_MS)
          ),
        ]);
        output = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        timedOut = !!(r as any)._timeout;
        if ((r as any)._interrupted) {
          // 记下中断状态，让调用方决定是否提前结束整轮
          interruptedDuringTools = true;
        }
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
  if (toolUses.length === 0) return { calls: [], interrupted: !!signal?.aborted };
  const toolNames = toolUses.map((b: any) => b.name!).join(', ');
  const toolStart = Date.now();
  let toolTick: ReturnType<typeof setInterval> | undefined;

  if (!silent) {
    // 立刻显示工具名（0s）
    engine.emit({ type: 'thinking_tick', label: toolNames, elapsedMs: 0 });

    // 心跳定时器（1s 心跳，避免高频 \r 覆写刺激 Terminal 渲染层）
    toolTick = setInterval(() => {
      engine.emit({ type: 'thinking_tick', label: toolNames, elapsedMs: Date.now() - toolStart });
    }, 1000);
  }

  const calls = serial
    ? await toolUses.reduce(async (prev, b) => {
        const acc = await prev;
        acc.push(await executeOne(b));
        return acc;
      }, Promise.resolve([] as any[]))
    : await Promise.all(toolUses.map(executeOne));

  if (toolTick) clearInterval(toolTick);
  const elapsed = Date.now() - toolStart;
  if (!silent) engine.emit({ type: 'tool_display', calls: engine.mergeToolCalls(calls), elapsedMs: elapsed });
  return { calls, interrupted: interruptedDuringTools || !!signal?.aborted };
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
          preRoundCheck, updateStats, phaseLabel, serialTools, silent, onRound } = params;
  // ⚠️ 局部别名：下面 preRoundCheck 的返回值也叫 signal（字符串），
  // 直接用 params.signal 会与它 shadow（踩过一次，导致中断检查永远读到 undefined）。
  const abortSignal = params.signal;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalToolCount = 0;

  // ---- 预算与护栏 ----
  const maxExtensions = params.maxExtensions ?? 3;
  const hardRounds = params.hardRounds ?? maxRounds * (1 + maxExtensions);
  const wallClockMs = params.wallClockMs ?? 45 * 60_000;
  const tokenBudget = params.tokenBudget ?? 0;
  const noProgressWarn = params.noProgressWarn ?? 3;
  const noProgressStop = params.noProgressStop ?? 6;

  const startedAt = Date.now();
  let softCap = maxRounds;   // 当前这一 grant 的轮数上限
  let extensions = 0;
  let round = 0;             // 全局轮序号
  let prevFp = '';
  let streak = 0;            // 连续相同指纹的轮数

  const done = (status: LoopResult['status'], text: string, extra?: Partial<LoopResult>): LoopResult => ({
    status, text, roundCount: round + 1, extensions, inputTokens, outputTokens, ...extra,
  });

  for (;;) {
    // ---- 用户中断：优先于所有预算/护栏判定 ----
    if (abortSignal?.aborted) {
      onComplete?.('(interrupted)');
      return done('killed', INTERRUPTED_TEXT);
    }
    // ---- 绝对上限 ----
    if (round >= hardRounds) {
      return done('max_rounds', `(round budget exhausted: ${round} rounds, ${extensions} extension(s))`, { roundCount: round });
    }
    // ---- 成本护栏 ----
    if (wallClockMs > 0 && Date.now() - startedAt > wallClockMs) {
      const reason = `wall-clock budget exceeded (${Math.round((Date.now() - startedAt) / 1000)}s after ${round} rounds)`;
      onComplete?.('(blocked)');
      return done('blocked', `(blocked: ${reason})`, { blockedReason: reason, roundCount: round });
    }
    if (tokenBudget > 0 && inputTokens + outputTokens > tokenBudget) {
      const reason = `token budget exceeded (${inputTokens + outputTokens} > ${tokenBudget} after ${round} rounds)`;
      onComplete?.('(blocked)');
      return done('blocked', `(blocked: ${reason})`, { blockedReason: reason, roundCount: round });
    }

    // ---- 软预算续期：不问模型「要不要继续」，而是把决定权交给它下一轮的行动 ----
    // 调工具 = 选择继续；只出文字（end_turn）= 选择收尾。零额外 API 调用。
    if (round >= softCap) {
      if (extensions >= maxExtensions) {
        return done('max_rounds', `(max iterations: ${round} rounds, ${extensions} extension(s) used)`, { roundCount: round });
      }
      const left = maxExtensions - extensions;
      const note = budgetNotice(round, maxRounds, hardRounds, left);
      messages.push({ role: 'user', content: note });
      if (!silent) engine.emit({ type: 'notice', kind: 'budget', text: note });
      softCap = round + maxRounds;
      extensions++;
    }

    // ---- 每轮前置检查（注入外部信号） ----
    if (preRoundCheck) {
      const signal = preRoundCheck(messages);
      if (signal) {
        if (signal.startsWith('BLOCKED:') || signal.startsWith('blocked:')) {
          const reason = signal.replace(/^BLOCKED:\s*/i, '');
          onComplete?.('(blocked)');
          return done('blocked', `(blocked: ${reason})`, { blockedReason: reason });
        }
        if (signal === '(killed)' || signal.startsWith('killed')) {
          onComplete?.('(killed)');
          return done('killed', signal);
        }
        messages.push({ role: 'user', content: `[SIGNAL] ${signal}` });
      }
    }

    if (abortSignal?.aborted) {
      onComplete?.('(interrupted)');
      return done('killed', INTERRUPTED_TEXT);
    }

    onRound?.(round);

    let response: { content: Array<unknown>; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } };
    try {
      const thinkStart = Date.now();
      const phase = phaseLabel?.(round, messages[messages.length - 1]?.content) ?? 'processing';
      let tick: ReturnType<typeof setInterval> | undefined;
      if (!silent) {
        engine.emit({ type: 'thinking_start', label: phase, time: thinkStart });

        // 心跳：每 1s 推一个 tick（避免高频 \r 覆写刺激 Terminal）
        tick = setInterval(() => {
          engine.emit({ type: 'thinking_tick', label: phase, elapsedMs: Date.now() - thinkStart });
        }, 1000);
      }

      try {
        response = await engine.llm.chat(messages, params.systemPrompt || engine.systemPrompt, 384000, abortSignal);
        if (response.usage) {
          inputTokens += response.usage.input_tokens;
          outputTokens += response.usage.output_tokens;
        }
      } finally {
        if (tick) clearInterval(tick);
      }

      const elapsedMs = Date.now() - thinkStart;
      const toolCount = (response.content as Array<{ type: string }>).filter(b => b.type === 'tool_use').length;
      if (!silent) engine.emit({ type: 'thinking_end', label: phase, elapsedMs, toolCount, time: Date.now() });
    } catch (e) {
      const err = e as Error;
      // 用户中断导致的 abort 不是崩溃：返回 killed，让 session_loop 走「提交 + 修复」路径。
      // 判据有三个（任一成立即中断）：
      //   1. signal 已 abort（我们自己发起的中断）
      //   2. 错误 name 是 UserAbortError（retry.ts 里抛的）
      //   3. 错误 name 是 AbortError 且 message 含 user —— undici 把 signal.abort() 包成 AbortError
      const isUserAbort = !!abortSignal?.aborted
        || err?.name === 'UserAbortError'
        || (err?.name === 'AbortError' && /user|interrupt|aborted by user/i.test(err.message || ''));
      if (isUserAbort) {
        onComplete?.('(interrupted)');
        return done('killed', INTERRUPTED_TEXT);
      }
      const errMsg = err.message || String(e);
      return done('crashed', `LLM call failed: ${errMsg}`);
    }

    if (response.stop_reason === 'end_turn') {
      // 推理模型（deepseek-v4-pro 等）有时返回空回合（无 text 也无 tool_calls）。
      // 不 push 空 assistant 消息：否则下一轮 openai.ts 会把它转成 content:null 发给 API，
      // 触发 "Invalid assistant message: content or tool_calls must be set" 400。
      const blocks = (response.content || []) as Array<{ type: string; text?: string }>;
      const hasText = blocks.some(b => b.type === 'text' && (b.text || '').trim().length > 0);
      if (hasText) messages.push({ role: 'assistant', content: response.content });
      const text = extractText(response);
      onTurnComplete?.(messages, totalToolCount);
      onComplete?.(text);
      return done('success', text || '(done)');
    }

    if (response.stop_reason === 'tool_use') {
      totalToolCount += countToolUses(response);
      const thoughts = extractThoughts(response);
      if (thoughts && !silent) engine.emit({ type: 'thought', text: thoughts });
      messages.push({ role: 'assistant', content: response.content });

      let feedback: string | undefined;
      if (thoughts) {
        const fm = thoughts.match(/\[FEEDBACK:\s*(.+?)\]/);
        const bm = thoughts.match(/\[BLOCKED:\s*(.+?)\]/);
        const nm = thoughts.match(/\[NEED:\s*(.+?)\]/);
        const fdm = thoughts.match(/\[FOUND:\s*(.+?)\]/);
        if (bm) feedback = `BLOCKED: ${bm[1]}`;
        else if (nm) feedback = `NEED: ${nm[1]}`;
        else if (fdm) feedback = `FOUND: ${fdm[1]}`;
        else if (fm) feedback = fm[1];
      }

      const exec = await executeTools(engine, response,
        (n, s, o, f) => updateStats?.(n, s, o, f || feedback || undefined), serialTools, silent, abortSignal);
      const toolResults = exec.calls;
      // ★ 先 pushResults 再判断中断：tool_use 已经在上面 push 过了，
      // 若直接 return 不补 tool_result，会话就会留下悬空 tool_use → 下次请求永久 400。
      pushResults(messages, engine, toolResults);

      // ---- 用户中断：工具结果已补齐配对，可以安全结束整轮 ----
      if (exec.interrupted || abortSignal?.aborted) {
        onComplete?.('(interrupted)');
        return done('killed', INTERRUPTED_TEXT);
      }

      // ---- 无进展检测：连续相同的 工具+参数+输出 ----
      const fp = roundFingerprint(toolResults);
      if (fp === prevFp) streak++; else { streak = 1; prevFp = fp; }

      if (streak >= noProgressStop) {
        const reason = `no progress: identical tool call(s) and results ${streak} rounds in a row`;
        onComplete?.('(blocked)');
        return done('blocked', `(blocked: ${reason})`, { blockedReason: reason });
      }
      if (streak === noProgressWarn) {
        const note = noProgressNotice(streak, toolResults);
        messages.push({ role: 'user', content: note });
        if (!silent) engine.emit({ type: 'notice', kind: 'no-progress', text: note });
      }
    } else {
      return done('crashed', `Unexpected stop_reason: ${response.stop_reason}`);
    }

    round++;
  }
}
