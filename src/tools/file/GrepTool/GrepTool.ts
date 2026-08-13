import { z } from 'zod/v4';
import { execSync } from 'node:child_process';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  pattern: z.string().describe('Regular expression to search for'),
  path: z.string().optional().describe('File or directory to search (default: cwd)'),
  include: z.string().optional().describe('File pattern filter, e.g. "*.ts"'),
  context: z.number().optional().describe('Lines of context before and after match (default 0)'),
});

const MAX_RESULTS = 100;

export const GrepTool = buildTool({
  name: 'Grep',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call({ pattern, path, include, context }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    const dir = path || '.';
    const ctx = context && context > 0 ? `-C ${context}` : '';
    const inc = include ? `--include="${include.replace(/"/g, '\\"')}"` : '';
    const escPattern = pattern.replace(/'/g, "'\\''");

    try {
      // Try ripgrep first (.gitignore-aware, faster)
      let stdout: string;
      try {
        const rgCmd = `rg -n --color=never ${ctx} ${inc} '${escPattern}' '${dir.replace(/'/g, "'\\''")}' 2>/dev/null`;
        stdout = execSync(rgCmd, { encoding: 'utf-8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        if (err.status === 1) return { data: '(no matches)' };
        // ripgrep failed — fall back to grep
        const grepCmd = `grep -rn --color=never ${ctx} ${inc} '${escPattern}' '${dir.replace(/'/g, "'\\''")}' --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null`;
        stdout = execSync(grepCmd, { encoding: 'utf-8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
      }

      const trimmed = stdout.trim();
      if (!trimmed) return { data: '(no matches)' };

      const lines = trimmed.split('\n');
      const result = lines.slice(0, MAX_RESULTS);
      const suffix = lines.length > MAX_RESULTS
        ? `\n(truncated: ${lines.length} matches, showing first ${MAX_RESULTS}. Use a more specific pattern or narrow the path.)`
        : '';
      return {
        data: `${lines.length} match${lines.length > 1 ? 'es' : ''} across files:\n\n${result.join('\n')}${suffix}`,
      };
    } catch {
      return { data: '(no matches)' };
    }
  },

  async prompt() { return `## GrepTool\n${DESCRIPTION}\nInput: { pattern, path?, include?, context? }`; },
  userFacingName: () => 'Grep',
  getToolUseSummary({ pattern }: Partial<z.infer<typeof inputSchema>>) {
    return pattern ? `Grep: ${pattern}` : null;
  },
});
