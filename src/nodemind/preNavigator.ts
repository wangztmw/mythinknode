/**
 * NodeMindPreNavigator — 前置检索：单层搜索，Agent 驱动深入。
 *
 * 策略：每层匹配后立即返回。Agent 先用内容尝试解决问题。
 * 解决 → 停止。不够 → Agent 调用 Knowledge(action='search', from=...) 继续下一层。
 */
import type { NodeMindStore } from './nodeMind_manage.js';
import { getSearchLLM } from './nodeMind_manage.js';
import type { LLMClient } from '../llm/types.js';
import { buildSearchPrompt } from './preNavigator_prompt.js';

function resolveLLM(passedLLM: LLMClient): { chat: any } {
  return getSearchLLM() || passedLLM;
}

// ---- 单层搜索（只返回匹配列表，不返回 content） ----

async function searchOneLayer(
  query: string,
  fromNodeIds: string[],
  store: NodeMindStore,
  llm: LLMClient,
): Promise<{ matches: MatchEntry[]; deeperIds: string[]; deeperHints: string[] }> {
  const matches: MatchEntry[] = [];
  const menuLines: string[] = [];
  const deeperIds: string[] = [];
  const deeperHints: string[] = [];

  for (const id of fromNodeIds) {
    const node = store.getNode(id);
    if (!node) continue;

    // 叶子 → 直接加入匹配列表
    if (node.children.length === 0) {
      matches.push({
        id: node.id, title: node.title, keywords: node.keywords,
        hasAttrs: node.attrs.length > 0, attrCount: node.attrs.length,
        hasChildren: false, childCount: 0,
        summarySnippet: node.content.replace(/\n/g, ' ').slice(0, 80),
      });
      continue;
    }

    // 有子节点 → 展示 keywords + children keywords → LLM 路由
    const attrNote = node.attrs.length > 0 ? ` [+${node.attrs.length} attrs]` : '';
    let entry = `[${node.id}] ${node.title}${attrNote}\n  keywords: ${node.keywords.join(', ')}`;
    for (const child of node.children) {
      entry += `\n    └ [${child.id}] ${child.title} — ${child.keywords.join(', ')}`;
    }
    menuLines.push(entry);
  }

  if (menuLines.length === 0) return { matches, deeperIds, deeperHints };

  try {
    const chatLLM = resolveLLM(llm);
    const response = await chatLLM.chat([{
      role: 'user',
      content: buildSearchPrompt(query, menuLines.join('\n\n'))
    }]);

    const text = (response.content as Array<{ type: string; text?: string }>)
      .filter(b => b.type === 'text').map(b => b.text || '').join(' ').trim().toLowerCase();
    if (text === 'none' || text === '') return { matches, deeperIds, deeperHints };

    const pickedIds = text.split(/[,\s]+/).map(s => s.replace(/[^a-z0-9-]/g, '').trim()).filter(s => s.length > 0);
    if (pickedIds.length === 0) return { matches, deeperIds, deeperHints };

    for (const pid of pickedIds) {
      const node = store.getNode(pid);
      if (!node) continue;

      matches.push({
        id: node.id, title: node.title, keywords: node.keywords,
        hasAttrs: node.attrs.length > 0, attrCount: node.attrs.length,
        hasChildren: node.children.length > 0, childCount: node.children.length,
        summarySnippet: node.content.replace(/\n/g, ' ').slice(0, 80),
      });

      if (node.children.length > 0) {
        deeperIds.push(pid);
        deeperHints.push(`[${pid}] ${node.title} — ${node.children.length} children: keywords ${node.children.map(c => c.keywords.join('|')).join(', ')}`);
      }
    }
  } catch { /* LLM 失败 */ }

  return { matches, deeperIds, deeperHints };
}

// ---- 公开 API ----

export interface MatchEntry {
  id: string;
  title: string;
  keywords: string[];
  hasAttrs: boolean;
  attrCount: number;
  hasChildren: boolean;
  childCount: number;
  summarySnippet: string;
}

export interface SearchResult {
  matches: MatchEntry[];         // 匹配节点列表（不含 content）
  deeperIds: string[];           // 可继续深入的节点 ID
  deeperHints: string[];         // 深入提示
}

export async function searchTree(
  query: string,
  store: NodeMindStore,
  llm: LLMClient,
  from: string[] = ['root'],
): Promise<SearchResult> {
  return searchOneLayer(query, from, store, llm);
}

/** 格式化匹配列表为可注入 messages 的文本 */
function formatMatchList(result: SearchResult, query: string, depth: number): string {
  if (result.matches.length === 0) return '';

  let text = result.matches.map(m => {
    const badges: string[] = [];
    if (m.hasAttrs) badges.push(`${m.attrCount} attrs`);
    if (m.hasChildren) badges.push(`${m.childCount} children`);
    const badge = badges.length > 0 ? ` (${badges.join(', ')})` : '';
    return `- **${m.id}**: ${m.title}${badge}\n  keywords: ${m.keywords.join(', ')}\n  ${m.summarySnippet}...`;
  }).join('\n\n');

  text += `\n\nUse Knowledge(action='read', nodeId='...') to read each node's full content one at a time.`;

  if (result.deeperIds.length > 0) {
    text += `\n\n> 💡 ${result.deeperIds.length} matches have deeper children. Search deeper with: Knowledge(action='search', query='${query}', from=${JSON.stringify(result.deeperIds)}, depth=${depth + 1})`;
  }

  return text;
}

export class NodeMindPreNavigator {
  private store: NodeMindStore;
  constructor(store: NodeMindStore) { this.store = store; }

  async search(query: string, _llm: LLMClient): Promise<string | null> {
    const root = this.store.getRoot();
    if (root.children.length === 0) return null;
    const result = await searchTree(query, this.store, _llm);
    if (result.matches.length === 0) return null;
    return formatMatchList(result, query, 0);
  }
}
