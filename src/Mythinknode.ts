/**
 * mythinknode — Minimal AI Coding Agent
 *
 * Session 循环 (本文件):  CLI 收用户输入 → 调 runSession → 渲染结果
 * Query 循环 (query_loop.ts):  for 轮次 LLM ↔ tool
 */

import { ConfigStore } from './config.js';
import { getAllTools } from './tools/core/index.js';
import { resolveLLM } from './llm/resolve.js';
import { AgentEngine } from './agent/agent_def.js';
import { Session } from './session/session_manage.js';
import { runSession } from './session_loop.js';
import { createCLI } from './cli/cli.js';
// 不再需要全局 stream monkey-patch。折行保护仅在 renderResult 中通过 safeWrite 显式应用。

// ---- 启动 ----

async function main() {
  const resumeIdx = process.argv.findIndex(a => a === '--resume' || a === '-r');
  const shouldResume = resumeIdx !== -1;

  const i = process.argv.indexOf('--api-key');
  if (i !== -1 && process.argv[i + 1]) process.env.MYTHINKNODE_API_KEY = process.argv[i + 1];

  const config = new ConfigStore();
  const tools = getAllTools();

  config.save({
    model: config.model,
    provider: config.provider,
    openaiBase: config.openaiBase,
  });

  const sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const session = new Session(sessionId);

  const llm = resolveLLM({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    openaiBase: config.openaiBase,
    tools,
    systemPrompt: '',
  });

  const engine = new AgentEngine(llm, tools);
  engine.onNotify = (msg: string) => session.addNotification(msg);

  // 搜索专用轻量 LLM
  const { setSearchLLM } = await import('./nodemind/nodeMind_manage.js');
  const searchLLM = resolveLLM({
    provider: config.provider,
    apiKey: config.apiKey,
    model: 'deepseek-v4-flash',
    openaiBase: config.openaiBase,
    tools: [],  // 搜索不需要工具
    systemPrompt: '',
    maxConcurrency: 4,  // 搜索可以更高并发
  });
  setSearchLLM(searchLLM);

  // infermem ingest 专用 LLM:抽取+语义判断用便宜/快模型(决策 #5),不挤主循环的 max=2。
  // 关键:不能用 deepseek-v4-pro(推理模型)——思考阶段超长,会卡在 fetchWithRetry 的 120s 单请求超时。
  const { setInfermemLLM } = await import('./infermem/ingest.js');
  const ingestLLM = resolveLLM({
    provider: config.provider,
    apiKey: config.apiKey,
    model: 'deepseek-v4-flash',   // 快模型:抽取 + 语义判断
    openaiBase: config.openaiBase,
    tools: [],  // 抽取不需要工具
    systemPrompt: '',
    maxConcurrency: 4,     // 与 ingest 的 INGEST_CONCURRENCY 对齐
  });
  setInfermemLLM(ingestLLM);

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
