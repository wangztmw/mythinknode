/**
 * TraitGraph —— 会话级「思维-执行」轨迹图工具。
 * 模型显式记录:plan(开目标) / step(记一次尝试) / backtrack(折返),status/read 读图。
 * 纯 JSON 读写,无需 LLM。
 */
import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';
import { getTraitGraphStore } from '../../../traitgraph/store.js';
import { getTraitGraphSessionId } from '../../../traitgraph/index.js';
import { renderStatus, renderNode } from '../../../traitgraph/format.js';

const inputSchema = z.object({
  action: z.enum(['status', 'read', 'plan', 'step', 'backtrack']).describe('status=看当前前沿/路径/死边 / read=读节点 / plan=开新目标 / step=记一次尝试 / backtrack=折返'),
  // read
  tag: z.string().optional().describe('read: 节点 tag(如 T3),缺省读 frontier'),
  nodeId: z.string().optional().describe('read: 节点 id(等价 tag)'),
  // plan
  goal: z.string().optional().describe('plan: 此刻的任务目标'),
  plan: z.string().optional().describe('plan: 打算怎么达成'),
  direction: z.string().optional().describe('plan/step: 打算尝试的方向'),
  summary: z.string().optional().describe('plan/step: 到这个节点为止建立的现状'),
  keywords: z.array(z.string()).optional().describe('plan/step: 检索关键词'),
  // step
  step_action: z.string().optional().describe('step: 做了什么'),
  result: z.string().optional().describe('step: 得到什么结果'),
  outcome: z.enum(['success', 'failed']).optional().describe('step: 结果成败'),
  from: z.string().optional().describe('step/backtrack: 出发节点(缺省=当前 frontier)'),
  // backtrack
  to: z.string().optional().describe('backtrack: 折返回到哪个节点'),
});

export const TraitGraphTool = buildTool({
  name: 'TraitGraph',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  async call(input: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    const sessionId = getTraitGraphSessionId();
    const store = getTraitGraphStore(sessionId);

    try {
      switch (input.action) {
        case 'status': {
          return { data: renderStatus(store) };
        }

        case 'read': {
          const id = input.tag ?? input.nodeId ?? store.getFrontier()?.id;
          if (!id) return { data: '没有可读节点。先 TraitGraph(action=\'plan\', ...)。' };
          const node = store.getNode(id);
          if (!node) return { data: `节点 "${id}" 不存在。用 TraitGraph(action='status') 看现有节点。` };
          return { data: renderNode(node) };
        }

        case 'plan': {
          if (!input.goal) return { data: 'Error: plan 需要 goal。' };
          const node = store.plan({
            goal: input.goal,
            plan: input.plan ?? '',
            direction: input.direction ?? '',
            summary: input.summary,
            keywords: input.keywords,
          });
          return { data: `已开新目标节点 ${node.id}。\n${renderNode(node)}` };
        }

        case 'step': {
          if (!input.step_action) return { data: 'Error: step 需要 step_action(做了什么)。' };
          const { node, edge } = store.step({
            action: input.step_action,
            result: input.result ?? '',
            outcome: input.outcome ?? 'success',
            plan: input.plan,
            direction: input.direction,
            summary: input.summary,
            keywords: input.keywords,
            from: input.from,
          });
          const mark = edge.outcome === 'success' ? '✓' : '✗';
          return { data: `${mark} ${edge.id}: ${edge.action}\n${renderNode(node)}` };
        }

        case 'backtrack': {
          if (!input.to) return { data: 'Error: backtrack 需要 to(折返回到哪个节点)。' };
          const marked = store.backtrack(input.to, input.from);
          const frontier = store.getFrontier();
          const summary = marked
            ? `已把 ${marked.id} 标为死路。`
            : '未找到可标死的入边(可能已折返过)。';
          return { data: `${summary}\n当前前沿回到 ${frontier ? `${frontier.id} — ${frontier.goal.slice(0, 60)}` : '(none)'}` };
        }
      }
    } catch (e) {
      return { data: `TraitGraph error: ${(e as Error).message}` };
    }
  },

  async prompt() { return `## TraitGraph\n${DESCRIPTION}\nInput: { action: 'status'|'read'|'plan'|'step'|'backtrack', ... }`; },
  userFacingName: () => 'TraitGraph',
  getToolUseSummary(input: Partial<z.infer<typeof inputSchema>>) {
    switch (input.action) {
      case 'status': return 'TraitGraph: status';
      case 'read': return `TraitGraph: read ${input.tag ?? input.nodeId ?? 'frontier'}`;
      case 'plan': return `TraitGraph: plan "${(input.goal ?? '').slice(0, 30)}"`;
      case 'step': return `TraitGraph: step ${(input.step_action ?? '').slice(0, 30)}`;
      case 'backtrack': return `TraitGraph: backtrack → ${input.to ?? ''}`;
      default: return 'TraitGraph';
    }
  },
});
