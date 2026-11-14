/**
 * 异步命令执行器 — 替代 execSync，不阻塞 Node 事件循环。
 *
 * 为什么需要：`execSync` 会同步占用主线程直到子进程退出，期间事件循环完全停摆，
 * 心跳 / spinner / 键盘输入 / 中断 / setTimeout 护栏全部失效。
 * 见 Plan/20261114-1518-async-tools/plan.md。
 *
 * 这里自行补齐 `execSync` 帮我们做的事：
 *   - timeout       → SIGTERM，2s 宽限后 SIGKILL，并标记 timedOut
 *   - maxBuffer     → 截断并标记 truncated（execSync 是抛 ENOBUFS，抛错对调用方无用）
 *   - encoding      → StringDecoder，避免 UTF-8 多字节字符跨 chunk 被切坏
 *   - AbortSignal   → 同样 SIGTERM → SIGKILL（这是「中断能真杀子进程」的基础）
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface RunResult {
  stdout: string;
  stderr: string;
  /** 退出码；被信号杀死时为 null */
  code: number | null;
  /** 杀死进程的信号；正常退出时为 null */
  signal: NodeJS.Signals | null;
  /** 是否因为超时被杀 */
  timedOut: boolean;
  /** 输出是否因超过 maxBuffer 被截断 */
  truncated: boolean;
}

export interface RunOptions {
  cwd?: string;
  /** 超时毫秒数，<=0 表示不超时。默认 120000 */
  timeoutMs?: number;
  /** stdout/stderr 各自的上限字节数。默认 10MB */
  maxBuffer?: number;
  /** 外部中断信号 */
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** SIGTERM 之后多久补 SIGKILL（给进程一点时间自己收尾） */
const SIGKILL_GRACE_MS = 2000;

export function runCommand(command: string, opts: RunOptions = {}): Promise<RunResult> {
  const {
    cwd = process.cwd(),
    timeoutMs = 120_000,
    maxBuffer = 10 * 1024 * 1024,
    signal,
    env,
  } = opts;

  return new Promise<RunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    // stdio[0] 必须是 'ignore'：否则子进程会和父进程抢 stdin，
    // 交互式命令（如 vim、read）会吞掉用户的按键。与改前 execSync 行为一致。
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const append = (text: string, which: 'stdout' | 'stderr') => {
      if (!text) return;
      const cur = which === 'stdout' ? stdout : stderr;
      if (cur.length >= maxBuffer) { truncated = true; return; }
      const next = cur + text;
      if (next.length > maxBuffer) {
        truncated = true;
        if (which === 'stdout') stdout = next.slice(0, maxBuffer);
        else stderr = next.slice(0, maxBuffer);
        return;
      }
      if (which === 'stdout') stdout = next;
      else stderr = next;
    };

    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      // flush 残留字节（可能是不完整的多字节序列，StringDecoder 会安全处理）
      append(outDecoder.end(), 'stdout');
      append(errDecoder.end(), 'stderr');
      resolve({ stdout, stderr, code, signal: sig, timedOut, truncated });
    };

    /** 先 SIGTERM，宽限后 SIGKILL。已经退出的进程 kill 会返回 false，无所谓。 */
    const terminate = () => {
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        }, SIGKILL_GRACE_MS);
      }
    };

    const onAbort = () => terminate();

    child.stdout?.on('data', (d: Buffer) => append(outDecoder.write(d), 'stdout'));
    child.stderr?.on('data', (d: Buffer) => append(errDecoder.write(d), 'stderr'));

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    }

    if (signal) {
      if (signal.aborted) terminate();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (e: Error) => {
      // spawn 失败（sh 不存在 / cwd 不存在等）：当作 stderr 内容 + 非零退出
      append(`\n${e.message}`, 'stderr');
      finish(null, null);
    });

    child.on('close', (code: number | null, sig: NodeJS.Signals | null) => finish(code, sig));
  });
}
