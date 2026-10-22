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

  // 本地模型生命周期追踪。/local 与 /cloud 可在运行时反复切换，
  // 而 config.local 只是启动瞬间的快照（切到 /local 后它仍是 false），
  // 因此必须用这个可变标志判断"退出时是否还有本地服务在跑"。
  let isLocalModel = config.local;

  /** 退出前停掉本地 llama-server。幂等：标志先置 false，防止 'exit' 与信号处理重复调用。 */
  const shutdownLocalServer = (): void => {
    if (!isLocalModel) return;
    isLocalModel = false;
    try { stopLocalServer(); } catch { /* 退出清理，静默 */ }
  };

  // infermem 落盘兜底:进程退出/被 kill 时强制写盘(即使 dirty 已清除,内存数据仍须落盘)。
  // 'exit' 是唯一可靠的收尾点：/exit、Ctrl+C(经典→process.exit、TUI→forceExit)、
  // 未捕获异常、以及下面信号处理器里的 process.exit(0) 最终都会走到这里。
  // 注意 handler 必须同步 —— saveAllStores 与 stopLocalServer(execFileSync) 均为同步调用。
  const { saveAllStores } = await import('./infermem/store.js');
  process.on('exit', () => {
    try { saveAllStores(); } catch { /* 退出清理,静默 */ }
    shutdownLocalServer();
  });

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

  // Session 循环 — 默认使用 Ink TUI；--classic / MYTHINKNODE_UI=classic 回退旧 CLI。
  // 非 TTY（管道/重定向）无法进入 raw mode，自动回退旧 CLI，避免启动崩溃。
  const wantsClassic = process.env.MYTHINKNODE_UI === 'classic' || process.argv.includes('--classic');
  const canTui = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const useTui = !wantsClassic && canTui;
  const cli = useTui
    ? await (await import('./cli/tui/session.js')).createTuiCLI()
    : createCLI();

  // 外部信号（kill -TERM/-INT、终端挂断 SIGHUP）：统一走 cli.close() 先恢复终端
  // （退出备用屏 / 关 bracketed paste / 还原 raw mode），其内部的 process.exit(0)
  // 再触发上面的 'exit' 处理器完成存盘 + 停本地服务。
  // 交互式 Ctrl+C 在 raw mode 下不会产生信号（经典/TUI 各自内部处理），此处是兜底。
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      try { cli.close(); } catch { /* 回落到底部 exit */ }
      process.exit(0);
    });
  }

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
      // 停服务必须在 summarize 之后：它可能还要调 LLM，本地模式先关机就调不通了。
      shutdownLocalServer();
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
          isLocalModel = true;
          refs = buildLLMs(localCfg, tools);
          applyLLMs(engine, refs, setSearchLLM, setInfermemLLM);
          cli.writeLines(`✅ 已切换到本地模型 ${localCfg.model}（${localCfg.openaiBase}）`);
        } else {
          const cloudCfg = ConfigStore.resolveCloud();
          stopLocalServer();
          isLocalModel = false;
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
