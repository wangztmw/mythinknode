import { z } from 'zod/v4';
import { execSync } from 'node:child_process';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts"'),
  path: z.string().optional().describe('Directory to search (default: cwd)'),
});

const MAX_RESULTS = 500;

export const GlobTool = buildTool({
  name: 'Glob',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call({ pattern, path }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    const dir = path || '.';
    try {
      // Try ripgrep first (faster + .gitignore-aware), fall back to find
      let stdout: string;
      try {
        stdout = execSync(
          `rg --files -g '${pattern.replace(/'/g, "'\\''")}' '${dir.replace(/'/g, "'\\''")}' 2>/dev/null`,
          { encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 },
        );
      } catch {
        stdout = execSync(
          `find '${dir.replace(/'/g, "'\\''")}' -path '${pattern.replace(/'/g, "'\\''")}' -not -path '*/node_modules/*' -not -path '*/.git/*' -maxdepth 8 2>/dev/null`,
          { encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 },
        );
      }

      const all = stdout.trim().split('\n').filter(Boolean).sort();
      if (all.length === 0) return { data: '(no matches)' };

      const truncated = all.slice(0, MAX_RESULTS);
      const suffix = all.length > MAX_RESULTS ? `\n(truncated: ${all.length} total, showing first ${MAX_RESULTS})` : '';
      return { data: truncated.join('\n') + suffix };
    } catch {
      return { data: '(no matches)' };
    }
  },

  async prompt() { return `## GlobTool\n${DESCRIPTION}\nInput: { pattern, path? }`; },
  userFacingName: () => 'Glob',
  getToolUseSummary({ pattern }: Partial<z.infer<typeof inputSchema>>) {
    return pattern ? `Glob: ${pattern}` : null;
  },
});
