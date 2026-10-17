/**
 * 本地大模型适配层（llama-server，OpenAI 兼容）
 *
 * 本地 llama-server 走 OpenAI 协议，所以"本地"本质上只是另一个 OpenAI base_url。
 * 但直接接入有 4 个障碍需要在这里统一处理：
 *   1. 假 key（本地无鉴权，需 sk- 前缀让 provider 判定为 openai）
 *   2. 硬编码模型名映射（deepseek-v4-flash → qwen3.5-4b）
 *   3. max_tokens 钳制（云端默认 384000 远超本地 ctx 8192）
 *   4. 自动启停（探测 /health → 没开就拉起 llama-server）
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../config.js';

export const LOCAL_BASE = 'http://127.0.0.1:8080';
export const LOCAL_MODEL = 'qwen3.5-4b';
export const LOCAL_API_KEY = 'sk-local';
export const LOCAL_MAX_TOKENS = 4096; // 本地 ctx 8192，留一半给 prompt

/** 云端模型名 → 本地模型名（修复 Mythinknode.ts 里的硬编码坏点） */
const MODEL_MAP: Record<string, string> = {
  'deepseek-v4-flash': LOCAL_MODEL,
  'deepseek-v4-pro': LOCAL_MODEL,
  'deepseek-chat': LOCAL_MODEL,
};

/** local 模式下把云端模型名映射到本地；非 local 模式原样返回（不破坏云端） */
export function localModelName(model: string, local: boolean): string {
  if (!local) return model;
  return MODEL_MAP[model] ?? LOCAL_MODEL;
}

/**
 * 本地脚本目录（start-daemon.sh / stop.sh 所在）。
 * 优先级：环境变量 > ~/.mythinknode/config.json 的 localScriptsDir > 通用默认目录。
 * 机器相关路径不写进仓库，避免把个人目录结构带到公开代码里。
 */
function localScriptsDir(): string {
  return (
    process.env.MYTHINKNODE_LOCAL_SCRIPTS
    || ConfigStore._loadFile().localScriptsDir
    || join(homedir(), '.mythinknode', 'local-scripts')
  );
}

async function healthCheck(timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 确保本地 llama-server 在运行：探测 /health，没开就后台拉起 start-daemon.sh
 * 并轮询等待就绪（模型加载约 7s，最长等 60s）。
 */
export async function ensureLocalServer(): Promise<void> {
  if (await healthCheck()) return;

  const script = join(localScriptsDir(), 'start-daemon.sh');
  if (!existsSync(script)) {
    throw new Error(
      `本地启动脚本不存在: ${script}\n请先准备好 start-daemon.sh / stop.sh，并通过环境变量 MYTHINKNODE_LOCAL_SCRIPTS 或 ~/.mythinknode/config.json 的 localScriptsDir 指定其目录`
    );
  }

  // 后台拉起（detached + unref，不阻塞主进程退出）
  spawn('bash', [script], { detached: true, stdio: 'ignore' }).unref();

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await healthCheck()) return;
  }
  throw new Error('本地 llama-server 启动超时(60s)。请手动运行 scripts/start.sh 排查日志 logs/llama-server.log');
}

/** 一键停止本地 llama-server（调 stop.sh：精确 PID kill，不触发安全拦截） */
export function stopLocalServer(): void {
  const script = join(localScriptsDir(), 'stop.sh');
  if (!existsSync(script)) return;
  try {
    execFileSync('bash', [script], { stdio: 'ignore' });
  } catch {
    /* 停止失败静默，交由用户手动处理 */
  }
}
