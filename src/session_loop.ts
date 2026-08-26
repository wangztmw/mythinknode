/**
 * Session 循环 — 每次用户输入触发一次完整管线：
 *   flush通知 → MessageReminder召回 → NodeMind前置检索 → agentLoop → post-loop guard → NodeMind反思 → 压缩
 *
 * 只管业务逻辑，不碰终端渲染。渲染在 cli/cli.ts。
 * 所有 pipeline 组件（MessageProcessor, MessageReminder, NodeMind）都在模块内自管理。
 */
import { AgentEngine } from './agent/agent_def.js';
import { Session } from './session/session_manage.js';
import { MessageProcessor } from './session/message-processor.js';
import { MessageReminder, type RecallResult } from './session/message-reminder.js';
import { agentLoop } from './query_loop.js';
import { NodeMindStore } from './nodemind/nodeMind_manage.js';
import { NodeMindPreNavigator } from './nodemind/preNavigator.js';
import { NodeMindReflector } from './nodemind/reflector.js';
import { flushPendingNotes, formatPendingNotes } from './tools/nodemind/RememberTool/RememberTool.js';
import { setTraitGraphSessionId, clearTraitGraphSessionId } from './traitgraph/index.js';
import { recallTraits } from './traitgraph/recall.js';
import { renderNode } from './traitgraph/format.js';
import type { ChatMessage } from './llm/types.js';

// ---- 模块级 pipeline 组件（惰性初始化） ----

let _processor: MessageProcessor | null = null;
let _processorSessionId: string | null = null;

let _nodemind: { navigator: NodeMindPreNavigator; reflector: NodeMindReflector } | null = null;

let _reminder: MessageReminder | null = null;

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

function getReminder(llm: { chat: any }): MessageReminder {
  if (!_reminder) _reminder = new MessageReminder(llm);
  return _reminder;
}

// ---- 跨轮次状态 ----

/** 记录当前逻辑任务的起点。max_rounds 后"继续"时复用 */
let taskStartLen = -1;

// ---- 召回上下文组装 ----

/** 从消息里识别 [S{n}] 块标记（压缩摘要块的开头） */
function extractBlockTag(m: ChatMessage): string | null {
  if (m.role !== 'user' || typeof m.content !== 'string') return null;
  const match = m.content.match(/^\[(S\d+)\]/);
  return match ? match[1] : null;
}

/** 把被召回的摘要块替换为原文，返回增强视图（新数组，不动原 messages） */
function buildBackground(messages: ChatMessage[], recall: RecallResult): ChatMessage[] {
  const tagSet = new Set(recall.tags);
  const out: ChatMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const tag = extractBlockTag(m);
    if (tag && tagSet.has(tag) && recall.blocks[tag]) {
      out.push(...recall.blocks[tag]);
      i++; // 跳过摘要 user 消息
      // 跳过紧随其后的 assistant 尾（原文块已含自己的 assistant 回复）
      if (i < messages.length && messages[i].role === 'assistant') i++;
    } else {
      out.push(m);
      i++;
    }
  }
  return out;
}

// ---- 主入口 ----

export async function runSession(
  engine: AgentEngine,
  session: Session,
  userInput: string,
): Promise<{ text: string; ms: number; inputTokens: number; outputTokens: number }> {
  const startTime = Date.now();
  setTraitGraphSessionId(session.id);
  const nodemind = getNodeMind();
  const processor = getProcessor(engine.llm, session.id);
  const reminder = getReminder(engine.llm);

  session.flushNotifications();
  session.addMessage({ role: 'user', content: userInput });

  const currentLen = session.messages.length;
  if (taskStartLen < 0) taskStartLen = currentLen;

  // ★ MessageReminder: 召回历史上下文，组装增强视图（不污染 session.messages）
  let queryMessages: ChatMessage[] = session.messages;
  let queryBaseLen = session.messages.length;
  try {
    const recall = await reminder.recall(userInput, session.keywordIndex, session.id);
    if (recall.tags.length > 0) {
      queryMessages = buildBackground(session.messages, recall);
      queryBaseLen = queryMessages.length;
    }
  } catch (e) { console.error('[MessageReminder] failed:', (e as Error).message); }

  // ★ Pre-query: NodeMind 检索相关知识并注入上下文
  try {
    const knowledge = await nodemind.navigator.search(userInput, engine.llm);
    if (knowledge) {
      queryMessages.push({
        role: 'user',
        content: `[NODE MIND — relevant past experience]\n${knowledge}\n\nUse Knowledge(action='search') to explore deeper, or Knowledge(action='browse') to see available topics.`
      });
    }
  } catch (e) { console.error('[NodeMind] PreNavigator failed:', (e as Error).message); }

  // ★ Pre-query: traitGraph 召回之前的思考轨迹并注入上下文
  try {
    const traitRecall = await recallTraits(userInput, session.id, engine.llm);
    if (traitRecall.nodes.length > 0) {
      const body = traitRecall.nodes.map(n => renderNode(n)).join('\n\n---\n\n');
      queryMessages.push({
        role: 'user',
        content: `[TRAIT GRAPH — your earlier thinking-execution trail in this session]\n${body}\n\nUse TraitGraph(action='status') to see the full current graph, or TraitGraph(action='plan'|'step'|'backtrack') to continue recording.`
      });
    }
  } catch (e) { console.error('[TraitGraph] recall failed:', (e as Error).message); }

  let loopResult = await agentLoop(engine, {
    messages: queryMessages,
    maxRounds: 25,
    onTurnComplete: (_msgs, tc) => { session.toolCount += tc; },

    phaseLabel: (i, lastMsg) => i === 0 ? 'analyzing' :
      typeof lastMsg === 'string' && lastMsg.length < 200 ? 'continuing' : 'reviewing results',
    preRoundCheck: () => {
      if (session.pendingNotifications.length > 0) {
        while (session.pendingNotifications.length > 0) {
          queryMessages.push(session.pendingNotifications.shift()! as ChatMessage);
        }
      }
      return null;
    },
  });

  // ★ 同步 queryMessages 新增消息回 session.messages（召回背景不落盘）
  if (queryMessages !== session.messages && queryMessages.length > queryBaseLen) {
    session.messages.push(...queryMessages.slice(queryBaseLen));
  }

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
      // ★ 写关键词索引（非空才写）
      if (result.keywords.length > 0) session.keywordIndex[result.tag] = result.keywords;
    }
    taskStartLen = -1;
  }

  clearTraitGraphSessionId();

  return {
    text: loopResult.text,
    ms: Date.now() - startTime,
    inputTokens: loopResult.inputTokens,
    outputTokens: loopResult.outputTokens,
  };
}
