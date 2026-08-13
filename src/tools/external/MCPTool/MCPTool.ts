import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  serverName: z.string().describe('MCP server name'),
  toolName: z.string().describe('Tool name within the server'),
  arguments: z.record(z.string(), z.unknown()).describe('Tool arguments'),
});

export const MCPTool = buildTool({
  name: 'MCP',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  async call({ serverName, toolName, arguments: args }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    // TODO: Real MCP client integration via @modelcontextprotocol/sdk
    return { data: `MCP ${serverName}/${toolName} called with ${JSON.stringify(args)}` };
  },
  async prompt() { return `## MCP\n${DESCRIPTION}\nInput: { serverName, toolName, arguments }`; },
  userFacingName: () => 'MCP',
});
