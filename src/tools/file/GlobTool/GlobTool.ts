import { z } from 'zod/v4';
import { runCommand } from '../../exec/run.js';
import { currentSignal } from '../../../agent/interrupt.js';
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
    // 异步执行：大仓库里 rg/find 可能耗时数百 ms ~ 数秒，
    // execSync 期间事件循环停摆（心跳/输入/中断全停）。见 Plan/20261114-1518-async-tools/。
    const tryRun = async (cmd: string): Promise<string | null | undefined> => {
      const r = await runCommand(cmd, { timeoutMs: 10000, maxBuffer: 1024 * 1024, signal: currentSignal() });
      if (r.signal) return undefined;            // 被中断 → 不再兜底
      return r.code === 0 ? r.stdout : null;     // null = 失败，可兜底
    };
    try {
      // Try ripgrep first (faster + .gitignore-aware), fall back to find
      const rgCmd = `rg --files -g '${pattern.replace(/'/g, "'\\''")}' '${dir.replace(/'/g, "'\\''")}' 2>/dev/null`;
      const findCmd = `find '${dir.replace(/'/g, "'\\''")}' -path '${pattern.replace(/'/g, "'\\''")}' -not -path '*/node_modules/*' -not -path '*/.git/*' -maxdepth 8 2>/dev/null`;
      const rg = await tryRun(rgCmd);
      if (rg === undefined) return { data: '(aborted)' };
      const found = rg ?? (await tryRun(findCmd));
      if (found === undefined) return { data: '(aborted)' };
      const stdout = found ?? '';
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
