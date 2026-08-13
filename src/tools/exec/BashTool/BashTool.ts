import { z } from 'zod/v4';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  command: z.string().describe('Shell command to execute'),
  description: z.string().optional().describe('Brief description of what this does'),
  timeout: z.number().optional().describe('Timeout in ms (default 120000, max 600000)'),
  run_in_background: z.boolean().optional().describe('Run in background; you will be notified when complete'),
});

// ============================================================
// Phase 46: Agent 自保机制
// ============================================================

// 自 PID 感知
const SELF_PID = process.pid;
const SELF_SCRIPT = process.argv[1] || '';
const SELF_BASENAME = path.basename(SELF_SCRIPT);
const SELF_IDENTITY: string[] = [
  SELF_BASENAME,
  SELF_BASENAME.replace(/\.[^.]+$/, ''), // 去掉扩展名
].filter(Boolean);

/** 检查命令是否引用了自身进程标识（如 kill/pkill + "main.js"/"dist"等） */
function targetsSelf(command: string): boolean {
  const killVerbs = /\b(kill|pkill|killall|SIGTERM|SIGKILL)\b/i;
  if (!killVerbs.test(command)) return false;
  const patterns = SELF_IDENTITY
    .map(id => { try { return new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'); } catch { return null; } })
    .filter(Boolean) as RegExp[];
  return patterns.some(p => p.test(command));
}

// 原有：文件系统破坏模式
const DANGEROUS_PATTERNS = [
  { pattern: /rm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s*\/(\b|$|\s)/, msg: 'recursive force delete from root' },
  { pattern: /rm\s+(-[a-z]*r[a-z]*f[a-z]*)\s*~\b/, msg: 'recursive force delete from home' },
  { pattern: />\s*\/dev\/sd[a-z]\d*/, msg: 'overwriting raw disk device' },
  { pattern: /mkfs\./, msg: 'creating filesystem (destroys data)' },
  { pattern: /dd\s+if=.*of=\/dev\//, msg: 'writing raw image to disk device' },
  { pattern: /:\s*\(\)\s*\{\s*:\|:\s*&\s*\};/, msg: 'fork bomb pattern' },
  { pattern: /chmod\s+(-R\s+)?777\s*\/\b/, msg: 'world-writable permissions on root' },
  // Phase 46 新增：系统级破坏
  { pattern: /\bkill\b\s+-9\s+1\b/, msg: 'SIGKILL on PID 1 (init/systemd)' },
  { pattern: /\breboot\b/, msg: 'system reboot' },
  { pattern: /\bshutdown\b/, msg: 'system shutdown' },
];

// Phase 46 新增：进程管理命令拦截（广播式杀进程 = 永远不应由 Agent 使用）
const PROCESS_MANAGEMENT_BLOCKED = [
  { pattern: /\bpkill\b/, msg: 'broadcast kill by name (pkill). Use task management system instead of shell process commands.' },
  { pattern: /\bkillall\b/, msg: 'broadcast kill by name (killall). Use task management system instead of shell process commands.' },
  { pattern: /\bps\b.*\|.*\bxargs\b.*\bkill\b/, msg: 'ps + xargs kill pipeline. Use task management system instead of shell process commands.' },
  { pattern: /\bpgrep\b.*\|.*\bxargs\b.*\bkill\b/, msg: 'pgrep + xargs kill pipeline. Use task management system instead.' },
  { pattern: /\bkill\b\s*-9\b/, msg: 'SIGKILL (-9) is too forceful. Use task management (TaskTool kill) for sub-agents or SIGTERM with exact PID for known processes.' },
];

export const BashTool = buildTool({
  name: 'Bash',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,

  async call({ command, description, timeout, run_in_background }: z.infer<typeof inputSchema>, ctx: ToolUseContext): Promise<ToolResult<string>> {
    // Phase 46: 进程管理命令拦截（广播式杀进程）
    for (const { pattern, msg } of PROCESS_MANAGEMENT_BLOCKED) {
      if (pattern.test(command)) {
        return { data: `BLOCKED: Unsafe process management — ${msg}\nCommand: ${command}\n\nYour PID is ${SELF_PID}. To manage sub-agents, use TaskTool (kill). For background bash tasks, use run_in_background.` };
      }
    }

    // Phase 46: 自引用检测
    if (targetsSelf(command)) {
      return { data: `BLOCKED: This command appears to target your own process (PID ${SELF_PID}).\nCommand: ${command}\n\nNever kill or signal your own process. Use /exit or /quit to stop, or TaskTool to manage sub-agents.` };
    }

    // 危险命令检查（文件系统 / 系统级破坏）
    for (const { pattern, msg } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { data: `BLOCKED: Dangerous command detected — ${msg}.\nCommand: ${command}` };
      }
    }

    // 后台执行
    if (run_in_background && ctx.engine) {
      const task = ctx.engine.createBashMember(description || command.slice(0, 80));
      const child = spawn('sh', ['-c', command], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', code => {
        const out = code === 0 ? stdout || '(no output)' : `Exit ${code}\n${stdout}\n${stderr}`;
        ctx.engine!.completeMember(task.id, out);
        const preview = out.slice(0, 1000);
        const hint = out.length > 1000 ? `\n... (${out.length - 1000} more chars. Use Agent(check, ${task.id}) for full output.)` : '';
        ctx.engine!.onNotify?.(`[Bash "${description || command.slice(0, 60)}" completed${code === 0 ? '' : ` (exit ${code})`}]:\n${preview}${hint}`);
      });
      return { data: `Background task spawned: ${task.id} ("${description || command.slice(0, 60)}")` };
    }

    try {
      const stdout = execSync(command, {
        encoding: 'utf-8',
        timeout: Math.min(timeout || 120000, 600000),
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { data: stdout || '(completed successfully, no output)' };
    } catch (e: unknown) {
      const err = e as {
        stdout?: Buffer | string; stderr?: Buffer | string;
        status?: number; signal?: NodeJS.Signals; message?: string;
      };
      const out = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString() || '';
      const errOut = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() || '';

      if (err.signal) {
        return { data: `Killed by signal ${err.signal}\nMessage: ${err.message || ''}\nStdout:\n${out}\nStderr:\n${errOut}` };
      }
      return {
        data: `Exit: ${err.status ?? 'unknown'}${err.message ? ' — ' + err.message : ''}\nStdout:\n${out}\nStderr:\n${errOut}`,
      };
    }
  },

  isConcurrencySafe: () => false,
  async prompt() { return `## Bash\n${DESCRIPTION}\nInput: { command, description?, timeout? }`; },
  userFacingName: () => 'Bash',
  getToolUseSummary({ command }: Partial<z.infer<typeof inputSchema>>) {
    return command ? `Bash: ${command.slice(0, 80)}` : null;
  },
});
