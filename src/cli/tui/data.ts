/**
 * TUI 数据层 — 只读采集项目运行时信息，不修改任何应用状态。
 *
 * 数据来源：
 *   - 配置：环境变量 > ~/.mythinknode/config.json（与 ConfigStore 保持一致）
 *   - 工具：getAllTools() 的启用列表
 *   - 系统：node/os/进程信息 + 记忆文件大小 + 会话数量
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { homedir, platform, arch, release, uptime } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../config.js';
import { getAllTools } from '../../tools/core/index.js';

export interface ConfigSummary {
  provider: string;
  model: string;
  openaiBase: string;
  maskedKey: string;
  keySource: '环境变量' | '配置文件' | '未设置';
  local: boolean;
}

export interface SystemSummary {
  version: string;
  node: string;
  os: string;
  arch: string;
  pid: number;
  uptime: string;
  cwd: string;
  memoryPath: string;
  memorySize: string;
  sessionCount: number;
}

export interface Snapshot {
  config: ConfigSummary;
  system: SystemSummary;
  tools: string[];
  toolError: string | null;
}

/** 只保留前 4 位与后 4 位，中间一律掩码；空 key 不泄露任何内容 */
function maskKey(key: string): string {
  if (!key) return '未设置';
  if (key.length <= 10) return '••••••••';
  return `${key.slice(0, 4)}${'•'.repeat(8)}${key.slice(-4)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function loadConfigSummary(): ConfigSummary {
  const file = ConfigStore._loadFile();
  const envKey = process.env.MYTHINKNODE_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const apiKey = envKey || file.apiKey || '';
  const local = process.env.MYTHINKNODE_LOCAL === '1' || process.argv.includes('--local');

  const provider = local
    ? 'openai（本地 llama-server）'
    : apiKey.startsWith('sk-ant-')
      ? 'anthropic'
      : apiKey.startsWith('sk-')
        ? 'openai'
        : (file.provider || 'unknown');

  const model = local
    ? (process.env.MYTHINKNODE_MODEL || 'qwen3.5-4b')
    : (process.env.MYTHINKNODE_MODEL || file.model || 'deepseek-chat');

  const openaiBase = local
    ? 'http://127.0.0.1:8080'
    : (process.env.OPENAI_BASE_URL || file.openaiBase || 'https://api.deepseek.com');

  return {
    provider,
    model,
    openaiBase,
    maskedKey: maskKey(apiKey),
    keySource: envKey ? '环境变量' : apiKey ? '配置文件' : '未设置',
    local,
  };
}

export function loadSystemSummary(): SystemSummary {
  const memPath = join(homedir(), '.mythinknode', 'MYTHINKNODE.md');
  let memorySize = '未创建';
  if (existsSync(memPath)) {
    try { memorySize = formatBytes(statSync(memPath).size); } catch { /* ignore */ }
  }

  let sessionCount = 0;
  try {
    const dir = join(homedir(), '.mythinknode', 'sessions');
    if (existsSync(dir)) sessionCount = readdirSync(dir).length;
  } catch { /* ignore */ }

  return {
    version: readVersion(),
    node: process.version,
    os: `${platform()} ${release()}`,
    arch: arch(),
    pid: process.pid,
    uptime: formatUptime(uptime()),
    cwd: process.cwd(),
    memoryPath: memPath,
    memorySize,
    sessionCount,
  };
}

export function loadTools(): { names: string[]; error: string | null } {
  try {
    return { names: getAllTools().map(t => t.name), error: null };
  } catch (e) {
    return { names: [], error: (e as Error).message || String(e) };
  }
}

export function collectSnapshot(): Snapshot {
  const tools = loadTools();
  return {
    config: loadConfigSummary(),
    system: loadSystemSummary(),
    tools: tools.names,
    toolError: tools.error,
  };
}
