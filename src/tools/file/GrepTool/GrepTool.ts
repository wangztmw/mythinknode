import { z } from 'zod/v4';
import { runCommand } from '../../exec/run.js';
import { currentSignal } from '../../../agent/interrupt.js';
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
      // 异步执行：大仓库里 rg/grep 可能耗时数百 ms ~ 数秒，execSync 期间事件循环停摆。
      const run = (cmd: string) =>
        runCommand(cmd, { timeoutMs: 15000, maxBuffer: 2 * 1024 * 1024, signal: currentSignal() });

      // Try ripgrep first (.gitignore-aware, faster)
      const rgCmd = `rg -n --color=never ${ctx} ${inc} '${escPattern}' '${dir.replace(/'/g, "'\\''")}' 2>/dev/null`;
      const rg = await run(rgCmd);
      if (rg.signal) return { data: '(aborted)' };

      let stdout: string;
      if (rg.code === 0) {
        stdout = rg.stdout;
      } else if (rg.code === 1) {
        // rg 退出码 1 = 没有匹配（不是失败），不兜底到 grep
        return { data: '(no matches)' };
      } else {
        const grepCmd = `grep -rn --color=never ${ctx} ${inc} '${escPattern}' '${dir.replace(/'/g, "'\\''")}' --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null`;
        const g = await run(grepCmd);
        if (g.signal) return { data: '(aborted)' };
        if (g.code !== 0 && !g.stdout) return { data: '(no matches)' };
        stdout = g.stdout;
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
