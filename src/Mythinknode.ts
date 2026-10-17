/**
 * mythinknode — Minimal AI Coding Agent
 *
 * Session 循环 (本文件):  CLI 收用户输入 → 调 runSession → 渲染结果
 * Query 循环 (query_loop.ts):  for 轮次 LLM ↔ tool
 */

import { ConfigStore, type ResolvedConfig } from './config.js';
import { getAllTools } from './tools/core/index.js';
import { resolveLLM } from './llm/resolve.js';
import { ensureLocalServer, localModelName, stopLocalServer, LOCAL_MAX_TOKENS } from './llm/local.js';
import { AgentEngine } from './agent/agent_def.js';
import { Session } from './session/session_manage.js';
import { runSession, resetPipelineCaches } from './session_loop.js';
import { createCLI } from './cli/cli.js';
import type { LLMClient } from './llm/types.js';
import type { Tools } from './tools/core/Tool.js';
// 不再需要全局 stream monkey-patch。折行保护仅在 renderResult 中通过 safeWrite 显式应用。

// ---- LLM 装配（/local ↔ /cloud 运行时切换复用）----

interface LLMRefs { llm: LLMClient; searchLLM: LLMClient; ingestLLM: LLMClient; }

function buildLLMs(cfg: ResolvedConfig, tools: Tools): LLMRefs {
  const sub = {
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    model: localModelName('deepseek-v4-flash', cfg.local),
    openaiBase: cfg.openaiBase,
    tools: [] as unknown as Tools,
    systemPrompt: '',
    maxConcurrency: cfg.local ? 2 : 4,
    maxTokensCap: cfg.local ? LOCAL_MAX_TOKENS : undefined,
  };
  return {
    llm: resolveLLM({
      provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model, openaiBase: cfg.openaiBase,
      tools, systemPrompt: '', maxTokensCap: cfg.local ? LOCAL_MAX_TOKENS : undefined,
    }),
    searchLLM: resolveLLM(sub),
    ingestLLM: resolveLLM(sub),
  };
}

function applyLLMs(
  engine: AgentEngine,
  refs: LLMRefs,
  setSearchLLM: (l: any) => void,
  setInfermemLLM: (l: any) => void,
): void {
  engine.llm = refs.llm;
  setSearchLLM(refs.searchLLM);
  setInfermemLLM(refs.ingestLLM);
  resetPipelineCaches();  // MessageProcessor / MessageReminder 缓存了旧 llm，须重建
}

// ---- 启动 ----

async function main() {
  const resumeIdx = process.argv.findIndex(a => a === '--resume' || a === '-r');
  const shouldResume = resumeIdx !== -1;

  const i = process.argv.indexOf('--api-key');
  if (i !== -1 && process.argv[i + 1]) process.env.MYTHINKNODE_API_KEY = process.argv[i + 1];

  const config = new ConfigStore();
  const tools = getAllTools();

  // 本地模式：自动拉起 llama-server（没开就启动并等就绪）
  if (config.local) {
    await ensureLocalServer();
  }

  // 仅在非本地模式回写配置（本地是临时覆盖，不能把 qwen3.5-4b/本地 base 写回 config.json 污染云端配置）
  if (!config.local) {
    config.save({ model: config.model, provider: config.provider, openaiBase: config.openaiBase });
  }

  const sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const session = new Session(sessionId);

  const { setSearchLLM } = await import('./nodemind/nodeMind_manage.js');
  const { setInfermemLLM } = await import('./infermem/ingest.js');

  let refs = buildLLMs(config, tools);

  const engine = new AgentEngine(refs.llm, tools);
  engine.onNotify = (msg: string) => session.addNotification(msg);
  applyLLMs(engine, refs, setSearchLLM, setInfermemLLM);

  // infermem 落盘兜底:进程退出/被 kill 时强制写盘(即使 dirty 已清除,内存数据仍须落盘)。
  // process.on('exit') 覆盖正常退出与未捕获异常;SIGTERM 覆盖 kill 命令。
  const { saveAllStores } = await import('./infermem/store.js');
  process.on('exit', () => { try { saveAllStores(); } catch { /* 退出清理,静默 */ } });
  process.on('SIGTERM', () => { try { saveAllStores(); } catch { /* 忽略 */ } process.exit(0); });

  if (shouldResume) {
    const picked = await Session.pickSession();
    if (picked) {
      session.id = picked.id;
      session.startedAt = picked.startedAt;
      session.messages = picked.messages;
      session.toolCount = picked.toolCount;
      session.cumulativeTokens = picked.cumulativeTokens;
      session.tokenMarkers = picked.tokenMarkers;
      session.pendingNotifications = picked.pendingNotifications;
    }
  }

  session.lock();

  // Session 循环
  const cli = createCLI();

  // banner 进备用屏 grid（console.log 会写到被隐藏的主屏）
  cli.writeLines(
    `mythinknode v0.6.0\n` +
    `Provider: ${config.provider}  |  Model: ${config.model}  |  Tools: ${tools.length}\n` +
    (config.local ? `本地模式: llama-server @ ${config.openaiBase}（切回云端: /cloud）\n` : '') +
    `Config: ~/.mythinknode/config.json  |  Memory: ~/.mythinknode/MYTHINKNODE.md\n` +
    `Type /help for commands, /exit to quit\n`
  );

  while (true) {
    const line = await cli.readLine();

    if (line === '/exit' || line === '/quit') {
      session.save();
      await session.summarize(engine.llm);  // LLM 分析对话 → 重命名目录
      session.save();
      session.unlock();
      cli.close();
    }
    if (line === '/help') {
      cli.showHelp(tools.map(t => t.name));
      continue;
    }
    if (line === '/local' || line === '/cloud') {
      try {
        if (line === '/local') {
          const localCfg = ConfigStore.localPreset();
          await ensureLocalServer();
          refs = buildLLMs(localCfg, tools);
          applyLLMs(engine, refs, setSearchLLM, setInfermemLLM);
          cli.writeLines(`✅ 已切换到本地模型 ${localCfg.model}（${localCfg.openaiBase}）`);
        } else {
          const cloudCfg = ConfigStore.resolveCloud();
          stopLocalServer();
          refs = buildLLMs(cloudCfg, tools);
          applyLLMs(engine, refs, setSearchLLM, setInfermemLLM);
          cli.writeLines(`✅ 已切回云端模型 ${cloudCfg.model}（本地服务已停止）`);
        }
      } catch (e) {
        cli.renderError((e as Error).message || String(e));
      }
      continue;
    }
    if (!line) continue;

    cli.setBusy(true);
    const stopRender = cli.startRender(engine);
    let result: Awaited<ReturnType<typeof runSession>>;
    try {
      result = await runSession(engine, session, line);
    } catch (e) {
      stopRender();
      cli.setBusy(false);
      cli.renderError((e as Error).message || String(e));
      session.save();
      continue;
    }
    // 先停渲染，再输出结果。推式事件下 runSession resolve 后不会再有 emit，
    // stopRender 只是安全网：刷掉最后的 pendingTick + 退订，保证结果渲染与进度事件原子。
    stopRender();
    cli.renderResult(result.text, result.ms, result.inputTokens, result.outputTokens);
    cli.setBusy(false);
    session.save();
  }
}

main().catch(console.error);
