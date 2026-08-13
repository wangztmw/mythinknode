import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  skill: z.string().describe('Skill name'),
  args: z.string().optional().describe('Optional arguments'),
});

export const SkillTool = buildTool({
  name: 'Skill',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => true,
  async call({ skill, args }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    return { data: `Skill "${skill}" invoked${args ? ` with: ${args}` : ''}` };
  },
  async prompt() { return `## Skill\n${DESCRIPTION}\nInput: { skill, args? }`; },
  userFacingName: () => 'Skill',
});
