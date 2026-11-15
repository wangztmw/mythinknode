/**
 * Config — 全部收在 ~/.mythinknode/ 目录下
 *   ~/.mythinknode/config.json     配置文件
 *   ~/.mythinknode/MYTHINKNODE.md  用户记忆
 *
 * 优先级：环境变量 > 配置文件
 * 设计原则：轻量（无锁、无监听、无备份），单用户单进程场景
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface ResolvedConfig {
  apiKey: string; model: string; provider: 'anthropic' | 'openai';
  openaiBase: string; tavilyApiKey?: string; local: boolean;
}

export class ConfigStore {
  apiKey: string;
  model: string;
  provider: 'anthropic' | 'openai';
  openaiBase: string;
  tavilyApiKey?: string;
  local: boolean;

  constructor() {
    const resolved = ConfigStore.resolve();
    this.apiKey = resolved.apiKey;
    this.model = resolved.model;
    this.provider = resolved.provider;
    this.openaiBase = resolved.openaiBase;
    this.tavilyApiKey = resolved.tavilyApiKey;
    this.local = resolved.local;
  }

  /** 环境变量 > 配置文件 */
  static resolve(): ResolvedConfig {
    const isLocal = process.env.MYTHINKNODE_LOCAL === '1' || process.argv.includes('--local');
    return isLocal ? ConfigStore.localPreset() : ConfigStore.resolveCloud();
  }

  /** 本地模式预设（llama-server Qwen3.5），供 --local / /local 命令共用 */
  static localPreset(): ResolvedConfig {
    const fileConfig = ConfigStore._loadFile();
    // 本地 llama-server 无需鉴权(假 key 同时让 provider 判定为 openai)
    return {
      apiKey: 'sk-local',
      model: process.env.MYTHINKNODE_MODEL || 'qwen3.5-4b',
      provider: 'openai',
      openaiBase: 'http://127.0.0.1:8080',
      tavilyApiKey: fileConfig.tavilyApiKey,
      local: true,
    };
  }

  /** 云端配置解析（强制忽略 local 开关），供启动 + /cloud 命令共用 */
  static resolveCloud(): ResolvedConfig {
    const fileConfig = ConfigStore._loadFile();
    const envApiKey = process.env.MYTHINKNODE_API_KEY || process.env.ANTHROPIC_API_KEY || '';
    const apiKey = envApiKey || fileConfig.apiKey || '';

    if (!apiKey) {
      console.error('Error: Set MYTHINKNODE_API_KEY or run with --api-key, or add apiKey to ~/.mythinknode/config.json');
      process.exit(1);
    }

    let provider: 'anthropic' | 'openai' = 'anthropic';
    if (apiKey.startsWith('sk-')) provider = 'openai';
    else if (apiKey.startsWith('sk-ant-')) provider = 'anthropic';

    const model = process.env.MYTHINKNODE_MODEL
      || fileConfig.model
      || (provider === 'openai' ? 'deepseek-chat' : 'claude-sonnet-5-20251001');

    const openaiBase = process.env.OPENAI_BASE_URL || fileConfig.openaiBase || 'https://api.deepseek.com';

    return { apiKey, model, provider, openaiBase, tavilyApiKey: fileConfig.tavilyApiKey, local: false };
  }

  /** 合并写入 ~/.mythinknode/config.json */
  save(partial: Partial<{ apiKey: string; model: string; provider: string; openaiBase: string; tavilyApiKey: string; visionProvider: string; visionModel: string }>): void {
    try {
      const dir = ConfigStore._dir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const current = ConfigStore._loadFile();
      const merged = { ...current, ...partial };
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(merged)) {
        if (v !== undefined) cleaned[k] = v;
      }
      // 同步回自身字段
      if (partial.apiKey) this.apiKey = partial.apiKey;
      if (partial.model) this.model = partial.model;
      if (partial.provider) this.provider = partial.provider as 'anthropic' | 'openai';
      if (partial.openaiBase) this.openaiBase = partial.openaiBase;

      writeFileSync(ConfigStore._path(), JSON.stringify(cleaned, null, 2), {
        encoding: 'utf-8', mode: 0o600,
      });
    } catch { /* 静默失败 */ }
  }

  /** 加载用户记忆（实例方法，等价于 readUserMemory()） */
  loadMemory(): string {
    return readUserMemory();
  }

  /** 写入用户记忆 */
  saveMemory(content: string): void {
    try {
      const dir = ConfigStore._dir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'MYTHINKNODE.md'), content, { encoding: 'utf-8', mode: 0o600 });
    } catch { /* 静默失败 */ }
  }

  // ---- 内部 ----

  private static _dir(): string { return join(homedir(), '.mythinknode'); }
  private static _path(): string { return join(ConfigStore._dir(), 'config.json'); }

  static _loadFile(): { apiKey?: string; model?: string; provider?: string; openaiBase?: string; tavilyApiKey?: string; visionProvider?: string; visionModel?: string; visionThinking?: boolean; localScriptsDir?: string } {
    try {
      if (!existsSync(ConfigStore._path())) return {};
      const raw = readFileSync(ConfigStore._path(), 'utf-8');
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed as ReturnType<typeof ConfigStore._loadFile> : {};
    } catch { return {}; }
  }
}

// 向后兼容导出（tools/search/WebSearchTool 等还在用 loadConfig）
export function loadConfig(): { tavilyApiKey?: string } {
  return ConfigStore._loadFile();
}

/**
 * 读用户记忆文件（~/.mythinknode/MYTHINKNODE.md）。
 *
 * 独立于 `ConfigStore` 存在，因为**读这个文件不需要任何凭据**。
 * `ConfigStore` 构造会走 `resolve()` —— 缺 API key 时直接 `process.exit(1)`。
 * 之前 `AgentEngine` 为了读记忆而无条件 `new ConfigStore()`，导致：
 *   - 任何只想构造引擎的场景（单元测试、CI、嵌入式使用）都被迫准备假 API key
 *   - 缺 key 时不是抛错而是静默杀掉整个进程，测试里表现为"断言数凭空变少"
 *
 * 凭据解析和本地文件读取是两件事，不该绑在一起。
 */
export function readUserMemory(): string {
  try {
    const p = join(homedir(), '.mythinknode', 'MYTHINKNODE.md');
    if (!existsSync(p)) return '';
    return readFileSync(p, 'utf-8').trim();
  } catch { return ''; }
}
