/**
 * NodeMindTool — 动态工具加载器。
 *
 * 职责：Knowledge 命中带 code+config attrs 的节点后，把该节点编译成一个真正的
 * 可调用 Tool，注册进 engine.toolMap 并刷新 LLM 客户端工具快照，使其能被
 * function calling 正常调用。实现「代码即知识、知识即可调用」。
 */
import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult, type Tool } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';
import { getNodeMindStore } from '../../../nodemind/nodeMind_manage.js';
import { buildToolFromAttrs } from './loader.js';

const inputSchema = z.object({
  action: z.enum(['load', 'list']).describe('load=register a tool from a node / list=show loaded dynamic tools'),
  nodeId: z.string().optional().describe('Node ID whose config+code attrs define the tool (required for load)'),
});

// 已动态加载的工具（模块级：name -> nodeId），供 list + 幂等判断
const _loadedTools = new Map<string, string>();

export const NodeMindTool = buildTool({
  name: 'NodeMindTool',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false, // load 会改动引擎工具表
  isConcurrencySafe: () => true,

  async call(input: z.infer<typeof inputSchema>, ctx: ToolUseContext): Promise<ToolResult<string>> {
    const store = getNodeMindStore();

    // ---- list ----
    if (input.action === 'list') {
      if (_loadedTools.size === 0) {
        return { data: 'No dynamically loaded tools. Use NodeMindTool(action=\'load\', nodeId=\'...\') to activate a tool stored in NodeMind.' };
      }
      const lines = [..._loadedTools.entries()].map(([name, nodeId]) => `- **${name}** ← node "${nodeId}"`);
      return { data: `Dynamically loaded tools:\n${lines.join('\n')}` };
    }

    // ---- load ----
    if (!input.nodeId) return { data: 'Error: nodeId required for load.' };
    const node = store.getNode(input.nodeId);
    if (!node) return { data: `Node "${input.nodeId}" not found.` };

    let tool: Tool;
    let name: string;
    try {
      ({ tool, name } = buildToolFromAttrs(node.attrs));
    } catch (e) {
      return { data: `Error: ${(e as Error).message}` };
    }

    const engine = ctx.engine as unknown as {
      registerTool?: (t: Tool) => void;
      toolMap?: Map<string, Tool>;
    };
    if (!engine?.registerTool) {
      return { data: 'Error: engine does not support runtime tool registration.' };
    }

    // 已存在同名内置工具 → 拒绝覆盖
    if (engine.toolMap?.has(name) && !_loadedTools.has(name)) {
      return { data: `Error: 工具名 "${name}" 已被内置工具占用，不能覆盖。请改 config attr 的 toolName。` };
    }

    engine.registerTool(tool);
    _loadedTools.set(name, input.nodeId);

    return {
      data: `✅ 已从节点 "${input.nodeId}" 加载工具 **${name}** 并注册，现在可被 function calling 调用。\n当前动态工具: ${[..._loadedTools.keys()].join(', ')}`,
    };
  },

  async prompt() { return `## NodeMindTool\n${DESCRIPTION}\nInput: { action: 'load'|'list', nodeId? }`; },
  userFacingName: () => 'NodeMindTool',
  getToolUseSummary(input: Partial<z.infer<typeof inputSchema>>) {
    if (input.action === 'list') return 'NodeMindTool: list';
    return input.nodeId ? `NodeMindTool: load ${input.nodeId}` : 'NodeMindTool';
  },
});
