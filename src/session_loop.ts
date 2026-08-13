/**
 * Session 循环 — 每次用户输入触发一次完整管线：
 *   flush通知 → NodeMind前置检索 → agentLoop → post-loop guard → NodeMind反思 → 压缩
 *
 * 只管业务逻辑，不碰终端渲染。渲染在 cli/cli.ts。
 * 所有 pipeline 组件（MessageProcessor, NodeMind）都在模块内自管理。
 */
import { AgentEngine } from './agent/agent_def.js';
import { Session } from './session/session_manage.js';
import { MessageProcessor } from './session/message-processor.js';
import { agentLoop } from './query_loop.js';
import { NodeMindStore } from './nodemind/nodeMind_manage.js';
import { NodeMindPreNavigator } from './nodemind/preNavigator.js';
import { NodeMindReflector } from './nodemind/reflector.js';
import { flushPendingNotes, formatPendingNotes } from './tools/nodemind/RememberTool/RememberTool.js';

// ---- 模块级 pipeline 组件（惰性初始化） ----

let _processor: MessageProcessor | null = null;
let _processorSessionId: string | null = null;

let _nodemind: { navigator: NodeMindPreNavigator; reflector: NodeMindReflector } | null = null;

function getProcessor(llm: { chat: any }, sessionId: string): MessageProcessor {
  if (_processor && _processorSessionId === sessionId) return _processor;
  _processor = new MessageProcessor(llm, sessionId);
  _processorSessionId = sessionId;
  return _processor;
}

function getNodeMind(): { navigator: NodeMindPreNavigator; reflector: NodeMindReflector } {
  if (!_nodemind) {
    const store = NodeMindStore.init();
    _nodemind = {
      navigator: new NodeMindPreNavigator(store),
      reflector: new NodeMindReflector(store),
    };
  }
  return _nodemind;
}

// ---- 跨轮次状态 ----

/** 记录当前逻辑任务的起点。max_rounds 后"继续"时复用 */
let taskStartLen = -1;

// ---- 主入口 ----

export async function runSession(
  engine: AgentEngine,
  session: Session,
  userInput: string,
): Promise<{ text: string; ms: number; inputTokens: number; outputTokens: number }> {
  const startTime = Date.now();
  const nodemind = getNodeMind();
  const processor = getProcessor(engine.llm, session.id);

  engine.events.length = 0;
  session.flushNotifications();
  session.addMessage({ role: 'user', content: userInput });

  const currentLen = session.messages.length;
  if (taskStartLen < 0) taskStartLen = currentLen;

  // ★ Pre-query: NodeMind 检索相关知识并注入上下文
  try {
    const knowledge = await nodemind.navigator.search(userInput, engine.llm);
    if (knowledge) {
      session.addMessage({
        role: 'user',
        content: `[NODE MIND — relevant past experience]\n${knowledge}\n\nUse Knowledge(action='search') to explore deeper, or Knowledge(action='browse') to see available topics.`
      });
    }
  } catch (e) { console.error('[NodeMind] PreNavigator failed:', (e as Error).message); }

  let loopResult = await agentLoop(engine, {
    messages: session.messages,
    maxRounds: 25,
    onTurnComplete: (_msgs, tc) => { session.toolCount += tc; },

    phaseLabel: (i, lastMsg) => i === 0 ? 'analyzing' :
      typeof lastMsg === 'string' && lastMsg.length < 200 ? 'continuing' : 'reviewing results',
    preRoundCheck: () => {
      if (session.pendingNotifications.length > 0) session.flushNotifications();
      return null;
    },
  });

  // Post-loop guard: 等后台 Agent 跑完，flush 信号通知
  const runningAfter = [...engine.team.values()].filter(m => m.status === 'running');
  if (runningAfter.length > 0) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const still = [...engine.team.values()].filter(m => m.status === 'running');
      if (still.length === 0) break;
      await new Promise(r => setTimeout(r, 500));
    }
    session.flushNotifications();
    const done = [...engine.team.values()].filter(m => m.status !== 'running');
    if (done.length > 0) {
      const signals = done.map(m =>
        `[Agent "${m.subject}" ${m.status}. Use Agent(action='check', taskId='${m.id}').]`
      ).join('\n');
      session.addMessage({ role: 'user', content: signals });
      loopResult = await agentLoop(engine, {
        messages: session.messages,
        maxRounds: 8,
        phaseLabel: () => 'summarizing agent results',
        preRoundCheck: () => { session.flushNotifications(); return null; },
      });
    }
  }

  // tokenMarkers
  const sessTokens = loopResult.inputTokens + loopResult.outputTokens;
  if (sessTokens > 0) {
    session.cumulativeTokens += sessTokens;
    session.tokenMarkers.push(session.cumulativeTokens);
  }

  // ★ Post-query: NodeMind 反思（在压缩之前！分析原文并维护经验树）
  if (loopResult.status === 'success') {
    // 先 flush Remember 标签到消息流
    const notes = flushPendingNotes();
    if (notes.length > 0) {
      session.addMessage({ role: 'user', content: formatPendingNotes(notes) });
    }

    try {
      await nodemind.reflector.reflect(session.messages, loopResult, engine.llm);
    } catch (e) { console.error('[NodeMind] Reflector failed:', (e as Error).message); }

    // MessageProcessor: 压缩（在反思之后）
    const start = taskStartLen > 0 ? taskStartLen : currentLen;
    const delta = session.messages.slice(start);
    const result = await processor.process(delta);
    if (result) {
      session.messages = [...session.messages.slice(0, start), ...result.compressed];
    }
    taskStartLen = -1;
  }

  return {
    text: loopResult.text,
    ms: Date.now() - startTime,
    inputTokens: loopResult.inputTokens,
    outputTokens: loopResult.outputTokens,
  };
}
