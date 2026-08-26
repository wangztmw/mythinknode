/**
 * NodeMindReflector — 后置反思：Query 循环成功后、上下文压缩前，独立分析会话并维护经验树。
 *
 * 规则：
 * - 有价值才记，不记流水账
 * - 一个 Session 最多创建 1 个经验节点
 * - content 必须系统化：任务→过程→发现→attrs 索引
 * - attrs 只在有具体代码/命令/配置/笔记时才建
 */
import type { NodeMindStore, Node, AttrNode } from './nodeMind_manage.js';
import type { ChatMessage, LLMClient } from '../llm/types.js';
import type { LoopResult } from '../query_loop.js';
import { buildReflectPrompt } from './reflector_prompt.js';

// ---- 容错 JSON 解析（LLM 输出常被 max_tokens 截断，需修复未闭合字符串/括号） ----

/** 引号感知地提取第一个完整闭合的 { ... } 块 */
function extractJsonBlock(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 修复被截断的 JSON：闭合未结束的字符串，补齐缺失的 } 和 ] */
function closeTruncatedJson(s: string): string {
  let out = '';
  let inString = false, escaped = false;
  let brace = 0, bracket = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    out += c;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
  }
  if (inString) out += '"';
  while (bracket-- > 0) out += ']';
  while (brace-- > 0) out += '}';
  return out;
}

/** 截掉末尾未完成的键值对（值写到一半就被截断的场景），作为二次兜底 */
function cutIncompleteTail(s: string): string | null {
  let inString = false, escaped = false;
  let lastComma = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === ',') lastComma = i;
  }
  if (lastComma < 0) return null;
  return s.slice(0, lastComma);
}

/** 分层尝试解析：完整块 → 截断修复 → 二次兜底。全失败返回 null */
function parseReflectorJson(text: string): any | null {
  const block = extractJsonBlock(text);
  if (block) {
    try { return JSON.parse(block); } catch { /* fall through */ }
  }
  const start = text.indexOf('{');
  if (start < 0) return null;
  const candidate = text.slice(start);
  const closed = closeTruncatedJson(candidate);
  if (closed) {
    try { return JSON.parse(closed); } catch { /* fall through */ }
    const cut = cutIncompleteTail(candidate);
    if (cut) {
      const closed2 = closeTruncatedJson(cut);
      if (closed2) {
        try { return JSON.parse(closed2); } catch { /* give up */ }
      }
    }
  }
  return null;
}

// ---- 工具调用链提取（逐段读原始 messages，保留完整过程） ----

function extractToolLog(messages: ChatMessage[]): string {
  const log: string[] = [];
  let roundNum = 0;
  let toolSeq = 0;

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;

    const blocks = msg.content as any[];
    const toolUses = blocks.filter((b: any) => b.type === 'tool_use');

    if (toolUses.length > 0) {
      roundNum++;
      for (const tu of toolUses) {
        toolSeq++;
        const input = JSON.stringify(tu.input || {}).slice(0, 150);
        log.push(`[R${roundNum}.${toolSeq}] ${tu.name}(${input})`);
      }
    }

    // 找紧跟着的 tool_result（下一个 user 消息中）
    const toolResults = blocks.filter((b: any) => b.type === 'tool_result');
    for (const tr of toolResults) {
      const output = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
      const isError = output.includes('Error:') || output.includes('error:') || output.includes('failed');
      const prefix = isError ? '  ❌ ' : '  → ';
      const trimmed = output.replace(/\n/g, ' ').slice(0, 200);
      log.push(`${prefix}${trimmed}${output.length > 200 ? '...' : ''}`);
    }
  }

  if (log.length === 0) return '(no tool calls)';
  return log.join('\n');
}

function extractUserGoal(messages: ChatMessage[]): string {
  const goals: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.startsWith('[') || content.match(/^\[S\d+\]/)) continue;
    if (content.length > 0 && content.length < 500) {
      goals.push(content.slice(0, 200));
    }
  }
  return goals.slice(-5).join(' | ') || '(unknown)';
}

function extractRememberTags(messages: ChatMessage[]): string {
  const tags: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.includes('[REMEMBER_TAG')) {
      tags.push(content);
    }
  }
  return tags.length > 0 ? `\n## Agent-Tagged Discoveries\n${tags.join('\n---\n')}` : '';
}

function extractPriorContext(messages: ChatMessage[]): string {
  const blocks: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.match(/^\[S\d+\]/)) {
      blocks.push(content.slice(0, 500)); // 截取前 500 字符
    }
  }
  return blocks.length > 0
    ? `\n## Prior Session Summaries (compressed — for context on what was done before)\n${blocks.join('\n---\n')}`
    : '';
}

function summarizeMessages(messages: ChatMessage[]): string {
  const goal = extractUserGoal(messages);
  const toolLog = extractToolLog(messages);
  const tags = extractRememberTags(messages);
  const prior = extractPriorContext(messages);

  return `## User Goal
${goal}
${prior}
${tags}
## Tool Execution Log (this session — read segment by segment)
${toolLog}`;
}

// ---- 公开类 ----

export class NodeMindReflector {
  private store: NodeMindStore;

  constructor(store: NodeMindStore) {
    this.store = store;
  }

  async reflect(
    messages: ChatMessage[],
    loopResult: LoopResult,
    llm: LLMClient,
  ): Promise<void> {
    // 检查是否有 Remember 标签 — 有标签就强制处理
    const hasTags = messages.some(m =>
      m.role === 'user' && typeof m.content === 'string' && m.content.includes('[REMEMBER_TAG')
    );

    // 无标签且回合数少 → 跳过
    if (!hasTags && loopResult.roundCount <= 1 && loopResult.status === 'success') return;

    const sessionSummary = summarizeMessages(messages);

    // 无标签且无工具调用 → 跳过（extractToolLog 在无工具时返回 '(no tool calls)'）
    if (!hasTags && sessionSummary.includes('(no tool calls)')) return;

    const treeSummary = this.store.buildTreeSummary('root', 0);

    let decision: any;
    try {
      const prompt = buildReflectPrompt({
        sessionSummary, treeSummary,
        outcome: loopResult.status,
        rounds: loopResult.roundCount,
      });
      const response = await llm.chat([{ role: 'user', content: prompt }], undefined, 384000);
      const text = (response.content as Array<{ type: string; text?: string }>)
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join(' ')
        .trim();

      decision = parseReflectorJson(text);
      if (!decision) return;
    } catch (e) {
      console.error('[NodeMind] Reflector LLM call failed:', (e as Error).message);
      return;
    }

    if (!decision || decision.action !== 'create' || !decision.title) return;

    try {
      const nodeId = decision.title
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      // title 全中文/全符号时 slug 后为空 → 无合法 id,直接跳过(与 attr 同一根因)
      if (!nodeId) return;

      // 确定父节点
      let parentId = decision.parentNode || 'root';
      if (!this.store.getNode(parentId)) parentId = 'root';

      // 构建 attrs
      const attrs: AttrNode[] = [];
      if (Array.isArray(decision.attrs)) {
        for (const a of decision.attrs) {
          if (!a.title || !a.fields || Object.keys(a.fields).length === 0) continue;
          const type = ['code', 'command', 'config', 'note'].includes(a.type) ? a.type : 'note';
          // title 全中文/全符号时 slug 后为空 → 直接丢弃，避免 store 校验报 "attr '?' missing"
          const attrId = a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
          if (!attrId) continue;
          attrs.push({
            id: attrId,
            title: a.title,
            type,
            content: a.content || '',
            fields: a.fields,
          });
        }
      }

      // 检查已存在 → 合并
      const existing = this.store.getNode(nodeId);

      const node: Node = {
        id: nodeId,
        title: decision.title,
        keywords: Array.isArray(decision.keywords) ? decision.keywords : (decision.about ? decision.about.split(/[;,，]\s*/) : []),
        content: existing
          ? `${existing.content}\n\n---\n**Updated ${new Date().toISOString().split('T')[0]}:**\n${decision.content}`
          : decision.content || '',
        children: [],
        attrs: existing
          ? this._mergeAttrs(existing.attrs, attrs)
          : attrs,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      this.store.upsertNode(node, parentId);
    } catch (e) {
      console.error('[NodeMind] Reflector upsertNode failed:', (e as Error).message);
    }
  }

  private _mergeAttrs(existing: AttrNode[], incoming: AttrNode[]): AttrNode[] {
    const merged = [...existing];
    for (const inc of incoming) {
      const idx = merged.findIndex(a => a.id === inc.id);
      if (idx >= 0) {
        merged[idx] = {
          ...merged[idx],
          fields: { ...merged[idx].fields, ...inc.fields },
          content: inc.content || merged[idx].content,
        };
      } else {
        merged.push(inc);
      }
    }
    return merged;
  }
}
