/**
 * Agent 引擎定义 — 类型、类、LLM调用、通知、工具合并、Agent 状态表
 *
 * 执行循环 agentLoop() 在 session_loop.ts 中。
 */
import type { Tool, Tools, ToolUseContext } from '../tools/core/Tool.js';
import type { LLMClient, ChatMessage } from '../llm/types.js';
import { ConfigStore } from '../config.js';

// ---- Agent 状态表 ----

export type MemberStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'killed';

export interface MemberState {
  id: string;
  type: 'local_agent' | 'local_bash';
  status: MemberStatus;
  subject: string;
  startTime: number;
  endTime?: number;
  output?: string;            // 完整输出（不再截断，check 时读）
  notified: boolean;
  feedback?: string;          // 子Agent 主动反馈
  abortController?: AbortController;
  agentLoop?: {               // 仅 local_agent
    roundCount: number;
    toolUseCount: number;
    lastActivity?: string;
    lastOutput?: string;
  };
  pendingInstruction?: string;
}

import type { ToolCall, MergedTool, ProgressEvent } from './progress.js';

// ---- 工具函数 ----

export function briefResult(data: string): string {
  const firstLine = data.split('\n')[0].slice(0, 80);
  return firstLine.length < data.length ? firstLine + '...' : firstLine;
}

export const SUB_AGENT_PROMPT = `You are a mythinknode sub-agent. Complete the assigned task and return a concise, specific report.

## Boundaries
- DO: use tools directly, read files, run commands, search the web — be autonomous.
- DO: report concrete results with file paths, commands used, error codes, numbers.
- NEVER: ask questions — you have no interactive user. If stuck, report [BLOCKED:reason].
- NEVER: retry failed network calls more than once. If a web tool fails twice, stop using it and rely on existing knowledge. Network reliability is outside your control — wasting rounds on retries blocks other agents.
- NEVER: do exhaustive search. Prioritize quick completion — a partial result with clear reasoning is better than timing out.

## Proactive Communication
Write these markers in your thinking to coordinate with the main agent:
- [NEED: what you need] — e.g. [NEED: search results for "JWT expiry standard"] if another agent might have this data
- [FOUND: interesting discovery] — e.g. [FOUND: the auth module uses a custom JWT library] to alert the main agent of unexpected findings

## Self-Check Before Reporting
[CHECKLIST]
- [ ] Task understood correctly
- [ ] All tool results reviewed and key findings extracted
- [ ] Report is concrete: includes file paths, commands, numbers, error codes where relevant
- [ ] No vague statements ("fixed the issue", "improved performance") without specifics

End with: [DONE] / [PARTIAL:reason] / [BLOCKED:reason]. Only mark [DONE] when all checklist items are checked.`;

// ---- 引擎类 ----

export class AgentEngine {
  llm: LLMClient;
  toolMap: Map<string, Tool>;
  toolContext: ToolUseContext;
  systemPrompt: string;
  private userMemory: string;

  /** 通知回调 — Agent 完成/BLOCKED 时调用。Session 层注入。 */
  onNotify?: (msg: string) => void;

  /** 进度事件监听器 — 前端（CLI/Web）订阅消费 */
  private eventListeners = new Set<(e: ProgressEvent) => void>();
  /** 最近一次 LLM 调用的 token 用量（query_loop 内部使用） */
  lastTokenUsage?: { input_tokens: number; output_tokens: number };

  /** 同步广播进度事件。监听器不应抛异常（这里防御性包裹）。 */
  emit(e: ProgressEvent): void {
    for (const l of this.eventListeners) { try { l(e); } catch { /* 渲染不应崩 */ } }
  }

  /** 订阅进度事件。返回退订函数。 */
  onEvent(listener: (e: ProgressEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  /** Agent 状态表——唯一持有者 */
  team: Map<string, MemberState> = new Map();

  constructor(
    llm: LLMClient,
    tools: Tools,
  ) {
    this.llm = llm;
    this.userMemory = new ConfigStore().loadMemory();
    this.toolMap = new Map(tools.map(t => [t.name, t]));
    this.toolContext = {
      options: { tools, verbose: false, isNonInteractiveSession: false, mainLoopModel: 'default', debug: false },
      abortController: new AbortController(),
      engine: this as any,
    };
    this.systemPrompt = this.buildSystemPrompt();
  }

  // ---- System Prompt ----

  buildSystemPrompt(): string {
    const now = new Date().toISOString().split('T')[0];
    const osInfo = `${process.platform} ${process.arch}`;
    const memory = this.userMemory;
    const sections = [
      `You are mythinknode, an AI coding assistant. Respond in English.`,
      `CWD: ${process.cwd()}  |  Date: ${now}  |  OS: ${osInfo}`,
      ``,
      ...(memory ? [`## User Memory`, memory, ``] : []),
      `## Core Rules`,
      `- Simple questions → answer directly. Complex tasks (multiple domains, many files) → dispatch Agents.`,
      `- Read before editing — editing without reading the current file state causes conflicts.`,
      `- Don't use cat/head/tail/sed/awk. Use Read for file contents, Edit for changes, Grep/Glob for search. Shell commands don't benefit from these tools.`,
      `- WebSearch/WebFetch → retry once with different keywords if first attempt fails, then use existing knowledge. Network calls are unreliable — don't retry indefinitely.`,
      `- Report what you tried and what happened, especially if stuck. Old results may be cleared from context — note key findings in your reply so they survive.`,
      ``,
      `## Agent Orchestration`,
      `- Dispatch one Agent per independent domain: Agent(action='spawn', background=true, description='...', prompt='...').`,
      `- After spawning: Agent(action='wait_any', timeout_ms=15000) — returns when the first Agent finishes.`,
      `- After wait_any: Agent(action='check', taskId=...) to read the report. Then either: (a) results sufficient → synthesize, (b) need more → wait_any again.`,
      `- Max 3 wait_any batches. After that, synthesize whatever is available — don't wait indefinitely.`,
      `- Blocked Agent → Agent(action='check') to read feedback → Agent(action='direct') to redirect, or Agent(action='kill') and re-spawn with a clearer prompt.`,
      `- Unsatisfactory results → re-spawn with a more precise prompt. Don't do the sub-agent's work yourself — that defeats the purpose of delegation.`,
      `- Sub-agents use [NEED: xxx] and [FOUND: xxx] markers. Check their status to route information between agents.`,
      ``,
      `## Knowledge & Experience`,
      `- Before starting a non-trivial task: Knowledge(action='search', query='...') to check if similar tasks were solved before. Skip for simple lookups.`,
      `- Knowledge returns ONE layer at a time. Try results first. Only search deeper (from=[] + depth=N) if the first layer doesn't solve the problem.`,
      `- Knowledge(browse) to see what's available. Knowledge(read) for full details including code/commands/configs.`,
      `- If you discover something reusable (a working method, a pitfall, concrete data): Remember(action='tag', ...). Reflector integrates it into the tree after the session.`,
      `- [S1], [S2]... are compressed past sessions (GOAL → TIMELINE → FINDINGS → FILES → NUMBERS). Full originals: raws/S{n}.json.`,
      `- TraitGraph records YOUR thinking-execution trail for THIS session: TraitGraph(action='plan', goal, plan, direction) to open a goal, TraitGraph(action='step', step_action, result, outcome) after each attempt, TraitGraph(action='backtrack', to=...) when a direction fails. It survives compression — check TraitGraph(action='status') to resume where you left off. [T1], [T2]... are its nodes, full text in traitraw/T{n}.json.`,
      ``,
      `## Agent Dispatch Guide`,
      `  DIRECT (handle yourself): single file edit, simple fact lookup, atomic git commit.`,
      `  DISPATCH (spawn Agents): codebase-wide changes, multi-domain tasks, research across files.`,
      `  Default: if unsure, handle directly. Dispatch only when the task is clearly multi-domain.`,
      ``,
      `## Tools`,
      ...[...this.toolMap.values()].map(t => `- **${t.name}**`),
    ];
    return sections.join('\n');
  }

  // ---- Agent 状态表操作 ----

  /** 创建 Agent 成员 */
  createAgentMember(subject: string, desc?: string): MemberState {
    const id = 'a' + Math.random().toString(36).slice(2, 10);
    const member: MemberState = {
      id, type: 'local_agent', status: 'pending', subject,
      startTime: Date.now(),
      notified: false,
      abortController: new AbortController(),
      agentLoop: { roundCount: 0, toolUseCount: 0 },
    };
    this.team.set(id, member);
    return member;
  }

  /** 创建 Bash 后台任务成员 */
  createBashMember(subject: string, desc?: string): MemberState {
    const id = 'b' + Math.random().toString(36).slice(2, 10);
    const member: MemberState = {
      id, type: 'local_bash', status: 'pending', subject,
      startTime: Date.now(),
      notified: false,
      abortController: new AbortController(),
    };
    this.team.set(id, member);
    return member;
  }

  /** 完成一个成员（Agent 或 Bash） */
  completeMember(id: string, output: string) {
    const m = this.team.get(id);
    if (m) {
      m.status = 'completed';
      m.endTime = Date.now();
      m.output = output;  // 存完整文本，不截断
    }
  }

  // ---- 工具调用合并（纯数据，不渲染） ----

  mergeToolCalls(calls: ToolCall[]): MergedTool[] {
    const merged: MergedTool[] = [];
    for (const c of calls) {
      const last = merged[merged.length - 1];
      let summary = this.toolMap.get(c.name)?.getToolUseSummary?.(c.input as never) || c.name;
      if (summary.startsWith(c.name + ': ')) summary = summary.slice(c.name.length + 2);
      else if (summary.startsWith(c.name + ' ')) summary = summary.slice(c.name.length + 1);
      if (last && last.name === c.name) {
        last.count++;
        last.inputs.push(summary);
        last.lines += c.output.split('\n').length;
      } else {
        merged.push({
          name: c.name, count: 1, inputs: [summary],
          lines: c.output.split('\n').length, sample: briefResult(c.output),
        });
      }
    }
    return merged;
  }
}
