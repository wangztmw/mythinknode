/**
 * mythinknode — Minimal AI Coding Agent
 *
 * Session 循环 (本文件):  CLI 收用户输入 → 调 runSession → 渲染结果
 * Query 循环 (query_loop.ts):  for 轮次 LLM ↔ tool
 */

// ---- 配置 ----
import { ConfigStore } from './cli/config.js';

// ---- 工具 ----
import { getAllTools } from './tools/core/index.js';

// ---- LLM ----
import { resolveLLM } from './llm/resolve.js';

// ---- 引擎 ----
import { AgentEngine } from './agent/agent_def.js';

// ---- 会话 ----
import { Session } from './session/session_manage.js';
import { runSession } from './session_loop.js';

// ---- CLI ----
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

  if (shouldResume) {
    const picked = await Session.pickSession();
    if (picked) {
      session.id = picked.id;
      session.messages = picked.messages;
      session.toolCount = picked.toolCount;
    }
  }

  session.lock();

  console.log(`mythinknode v0.6.0`);
  console.log(`Provider: ${config.provider}  |  Model: ${config.model}  |  Tools: ${tools.length}`);
  console.log(`Config: ~/.mythinknode/config.json  |  Memory: ~/.mythinknode/MYTHINKNODE.md`);
  console.log('Type /help for commands, /exit to quit\n');

  // Session 循环
  const cli = createCLI();

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
    try {
      const result = await runSession(engine, session, line);
      cli.renderResult(result.text, result.ms, result.inputTokens, result.outputTokens);
    } catch (e) {
      cli.renderError((e as Error).message || String(e));
    } finally {
      stopRender();
      cli.setBusy(false);
    }
    session.save();
  }
}

main().catch(console.error);
