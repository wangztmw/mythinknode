import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';
import type { MemberState } from '../../../agent/agent_def.js';
import { SUB_AGENT_PROMPT } from '../../../agent/agent_def.js';
import { agentLoop } from '../../../query_loop.js';
import type { ChatMessage } from '../../../llm/types.js';

const inputSchema = z.object({
  action: z.enum(['spawn', 'check', 'wait_any', 'direct', 'kill']).describe(
    'spawn=派子Agent / check=读报告 / wait_any=等任意完成 / direct=调控 / kill=终止'
  ),
  description: z.string().optional().describe('Short title (for spawn)'),
  prompt: z.string().optional().describe('Task for sub-agent (for spawn)'),
  background: z.boolean().optional().describe('Run in background, notify when done (for spawn)'),
  taskId: z.string().optional().describe('Agent ID (for check/direct/kill)'),
  instruction: z.string().optional().describe('New instruction (for direct)'),
  timeout_ms: z.number().optional().describe('Max wait ms (for wait_any, default 15000)'),
});

function fmtMember(m: MemberState): string {
  const elapsed = Math.round(((m.endTime || Date.now()) - m.startTime) / 1000);
  const bell = m.feedback ? '🔔 ' : '';
  const icon = m.status === 'running' ? '⏳' : m.status === 'completed' ? '✓' : m.status === 'blocked' ? '⏸' : m.status === 'killed' ? '✗' : '?';
  let line = `${bell}${icon} [${m.status}] ${m.id}: ${m.subject} (${elapsed}s)`;
  if (m.agentLoop && (m.status === 'running' || m.status === 'blocked')) {
    line += ` — round ${m.agentLoop.roundCount}, ${m.agentLoop.toolUseCount} tools`;
    if (m.agentLoop.lastActivity) line += `, last: ${m.agentLoop.lastActivity}`;
  }
  if (m.feedback) line += `\n       💬 "${m.feedback.slice(0, 100)}"`;
  if (m.output && m.status !== 'running' && m.status !== 'blocked') {
    line += ` → ${m.output.slice(0, 80)}`;
  }
  return line;
}

export const AgentTool = buildTool({
  name: 'Agent',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  async call(input: z.infer<typeof inputSchema>, ctx: ToolUseContext): Promise<ToolResult<string>> {
    const engine = ctx.engine as any; // agentLoop 需要完整 AgentEngine
    if (!engine) return { data: 'Agent system not initialized.' };
    const { action } = input;

    // ---- wait_any ----
    if (action === 'wait_any') {
      const deadline = Date.now() + (input.timeout_ms || 15000);
      while (Date.now() < deadline) {
        const all = [...engine.team.values()];
        const changed = all.filter(m => m.status !== 'running' && m.status !== 'pending');
        if (changed.length > 0) {
          const done = changed.filter(m => m.status === 'completed');
          const blocked = changed.filter(m => m.status === 'blocked');
          const failed = changed.filter(m => m.status === 'failed');
          const parts: string[] = [];
          if (done.length > 0) parts.push(`${done.length} completed`);
          if (blocked.length > 0) parts.push(`${blocked.length} blocked`);
          if (failed.length > 0) parts.push(`${failed.length} failed`);
          const latest = changed.sort((a, b) => (b.endTime || 0) - (a.endTime || 0))[0];
          return { data: `${parts.join(', ')}.\n\nLatest: ${fmtMember(latest)}\n\nUse Agent(action='check', taskId='${latest.id}') for full report, Agent(action='wait_any') to keep waiting.` };
        }
        await new Promise(r => setTimeout(r, 500));
      }
      const running = [...engine.team.values()].filter(m => m.status === 'running');
      return { data: `No agent completed yet. ${running.length} still running:\n${running.slice(0, 5).map(fmtMember).join('\n')}\n\nUse Agent(action='wait_any') again, or Agent(action='check', taskId=...) to inspect.` };
    }

    // ---- check ----
    if (action === 'check') {
      if (!input.taskId) return { data: 'Error: taskId required for check.' };
      const m = engine.team.get(input.taskId);
      if (!m) return { data: `Agent ${input.taskId} not found.` };
      let result = '';
      if (m.feedback) result += `⚠️  AGENT HAS FEEDBACK: "${m.feedback}"\n\n`;
      result += `${fmtMember(m)}\n`;
      if (m.agentLoop && m.status === 'running') {
        result += `\nLive progress:\n  Round: ${m.agentLoop.roundCount}/10\n  Tools called: ${m.agentLoop.toolUseCount}\n`;
        if (m.agentLoop.lastActivity) result += `  Last activity: ${m.agentLoop.lastActivity}\n`;
        if (m.agentLoop.lastOutput) result += `  Last output: ${m.agentLoop.lastOutput.slice(0, 300)}\n`;
      }
      if (m.output) {
        result += `\nOutput:\n${m.output.slice(0, 3000)}`;
        if (m.output.length > 3000) result += `\n... (${m.output.length - 3000} more chars)`;
      }
      return { data: result };
    }

    // ---- direct ----
    if (action === 'direct') {
      if (!input.taskId) return { data: 'Error: taskId required for direct.' };
      if (!input.instruction) return { data: 'Error: instruction required for direct.' };
      const m = engine.team.get(input.taskId);
      if (!m) return { data: `Agent ${input.taskId} not found.` };
      if (m.status !== 'running') return { data: `Agent ${input.taskId} is ${m.status}, cannot inject instruction.` };
      m.pendingInstruction = `🔔 主Agent指令（最高优先级，按此执行）: ${input.instruction}`;
      return { data: `Instruction sent to ${input.taskId} ("${m.subject}"): ${input.instruction}` };
    }

    // ---- kill ----
    if (action === 'kill') {
      if (!input.taskId) return { data: 'Error: taskId required for kill.' };
      const m = engine.team.get(input.taskId);
      if (!m) return { data: `Agent ${input.taskId} not found.` };
      if (m.abortController) { try { m.abortController.abort(); } catch {} }
      m.status = 'killed';
      m.endTime = Date.now();
      return { data: `Agent ${input.taskId} ("${m.subject}") killed.` };
    }

    // ---- spawn ----
    // action === 'spawn'
    if (!input.description || !input.prompt) {
      return { data: 'Error: description and prompt required for spawn.' };
    }

    const member = engine.createAgentMember(input.description, input.prompt.slice(0, 200));

    const messages: ChatMessage[] = [
      { role: 'user', content: `Complete this task:\n${input.prompt}\n\nReturn a concise report.` },
    ];

    const subConfig = {
      messages,
      maxRounds: 10,
      serialTools: true as const,
      systemPrompt: SUB_AGENT_PROMPT,
      silent: true,
      onRound: (i: number) => {
        if (member.agentLoop) member.agentLoop.roundCount = i + 1;
      },
      preRoundCheck: (_msgs: ChatMessage[]) => {
        if (member.status === 'blocked') return `BLOCKED: ${member.feedback || 'no reason'}`;
        if (member.pendingInstruction) {
          messages.push({ role: 'user', content: member.pendingInstruction });
          member.pendingInstruction = undefined;
          return null;
        }
        if (member.abortController?.signal.aborted) {
          member.status = 'killed';
          return '(killed)';
        }
        return null;
      },
      updateStats: (name: string, summary: string, output: string, feedback?: string) => {
        if (member.agentLoop) {
          member.agentLoop.toolUseCount++;
          member.agentLoop.lastActivity = `${name}(${summary})`;
          member.agentLoop.lastOutput = output.slice(0, 200);
        }
        if (feedback) {
          member.feedback = feedback;
          if (feedback.startsWith('BLOCKED:')) {
            member.status = 'blocked';
          }
          // 所有 feedback 都通知主 Agent（BLOCKED/NEED/FOUND）
          engine.onNotify?.(`[Agent "${input.description}" ${feedback}. Use Agent(action='check', taskId='${member.id}').]`);
        }
      },
    };

    if (input.background) {
      await new Promise(r => setTimeout(r, Math.random() * 500));
      agentLoop(engine, subConfig).then(result => {
        if (result.status === 'success') {
          const blocked = result.text.match(/\[BLOCKED:\s*(.+?)\]/);
          if (blocked) {
            member.status = 'blocked';
            member.feedback = `BLOCKED: ${blocked[1]}`;
            member.endTime = Date.now();
            member.output = result.text;
          } else {
            engine.completeMember(member.id, result.text);
          }
        } else {
          // 保留 preRoundCheck 已经设置的 killed——不要覆盖
          if (member.status !== 'killed') {
            member.status = result.status === 'blocked' ? 'blocked' : 'failed';
          }
          member.endTime = Date.now();
          member.output = `[${result.status}] ${result.text}`;
          if (result.blockedReason) member.feedback = result.blockedReason;
        }
        const elapsed = Math.round((Date.now() - member.startTime) / 1000);
        const active = [...engine.team.values()].filter(x => x.status === 'running').length;
        engine.onNotify?.(`[Agent "${input.description}" ${result.status === 'success' ? 'done' : result.status} in ${elapsed}s${active > 0 ? `, ${active} still running` : ''}. Use Agent(action='check', taskId='${member.id}') for report.]`);
      }).catch(err => {
        member.status = 'failed';
        member.endTime = Date.now();
        member.output = `(crashed: ${(err as Error).message})`;
        engine.onNotify?.(`[Agent "${input.description}" crashed. Use Agent(action='check', taskId='${member.id}').]`);
      });
      return { data: `Agent spawned: ${member.id} ("${input.description}" pending in background)` };
    }

    // 同步模式
    try {
      const result = await agentLoop(engine, subConfig);
      if (result.status === 'success') {
        const blocked = result.text.match(/\[BLOCKED:\s*(.+?)\]/);
        if (blocked) {
          member.status = 'blocked';
          member.feedback = `BLOCKED: ${blocked[1]}`;
          member.endTime = Date.now();
          member.output = result.text;
        } else {
          engine.completeMember(member.id, result.text);
        }
      } else {
        if (member.status !== 'killed') {
          member.status = result.status === 'blocked' ? 'blocked' : 'failed';
        }
        member.endTime = Date.now();
        member.output = `[${result.status}] ${result.text}`;
        if (result.blockedReason) member.feedback = result.blockedReason;
      }
      return { data: `[Agent "${input.description}" ${member.status === 'blocked' ? 'blocked' : result.status === 'success' ? 'report' : result.status}]:\n${result.text}` };
    } catch (e) {
      member.status = 'failed';
      member.endTime = Date.now();
      member.output = `(crashed: ${(e as Error).message})`;
      return { data: `Agent error: ${(e as Error).message}` };
    }
  },

  async prompt() { return `## Agent\n${DESCRIPTION}\nInput: { action: 'spawn'|'check'|'wait_any'|'direct'|'kill', ... }`; },
  userFacingName: () => 'Agent',
  getToolUseSummary(input: Partial<z.infer<typeof inputSchema>>) {
    if (input.action === 'check' || input.action === 'direct' || input.action === 'kill') return `Agent: ${input.action} ${input.taskId || ''}`;
    if (input.action === 'wait_any') return `Agent: wait_any`;
    return input.description ? `Agent: ${input.description}` : 'Agent';
  },
});
