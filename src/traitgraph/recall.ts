/**
 * traitgraph 召回 —— 从 trait-index.json 按关键词召回思考轨迹节点。
 *
 * 复用 MessageReminder 的「候选集 → LLM 选 → 反查 tag → 时间序」流程,
 * 但读 traitraw/ 而非 raws/。命中结果由 session_loop 注入为背景上下文。
 */
import type { TraitNode, TraitStep } from './schema.js';
import type { LLMClient } from '../llm/types.js';
import { loadTraitIndex, loadTraitStep } from '../session/session_raw.js';

function tagOrder(tag: string): number {
  return parseInt(tag.replace(/^T/, ''), 10) || 0;
}

function extractText(response: { content: unknown[] }): string {
  return (response.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
}

/** 从 LLM 输出里解析选中关键词,只接受候选集里存在的(防 LLM 瞎编) */
function parseSelected(text: string, candidates: string[]): string[] {
  const m = text.match(/\[[\s\S]*?\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) return arr.filter((k): k is string => typeof k === 'string' && candidates.includes(k));
    } catch { /* fall through */ }
  }
  return text.split(/[,，、\n]/)
    .map(s => s.trim().replace(/["\[\]]/g, ''))
    .filter(k => candidates.includes(k));
}

function buildPrompt(userInput: string, candidates: string[]): string {
  return `从下面的候选关键词里,选出与用户当前输入最相关的若干(0-5个),只返回 JSON 数组。找不到相关的就返回 []。

用户输入: ${userInput}

候选关键词:
${candidates.map(c => `- ${c}`).join('\n')}`;
}

export interface TraitRecallResult {
  tags: string[];                 // 命中的 T 序号,升序(=时间序)
  nodes: TraitNode[];             // 对应节点(含回溯步的节点)
}

/** 召回思考轨迹。llm 是 { chat } 形状(缺省跳过 LLM 选择,返回空)。 */
export async function recallTraits(
  userInput: string,
  sessionId: string,
  llm: LLMClient | null,
): Promise<TraitRecallResult> {
  const empty: TraitRecallResult = { tags: [], nodes: [] };
  const index = loadTraitIndex(sessionId);
  const tags = Object.keys(index);
  if (tags.length === 0) return empty;

  const candidates = [...new Set(tags.flatMap(t => index[t]))];
  if (candidates.length === 0) return empty;

  let selected: string[] = [];
  if (llm) {
    try {
      const r = await llm.chat([{ role: 'user', content: buildPrompt(userInput, candidates) }]);
      selected = parseSelected(extractText(r), candidates);
    } catch { /* LLM 失败 → 空,不影响主流程 */ }
  }
  if (selected.length === 0) return empty;

  const hit = new Set<string>();
  for (const [tag, kws] of Object.entries(index)) {
    if (kws.some(k => selected.includes(k))) hit.add(tag);
  }

  const ordered = [...hit].sort((a, b) => tagOrder(a) - tagOrder(b));
  const nodes: TraitNode[] = [];
  for (const tag of ordered) {
    const step = loadTraitStep(sessionId, tag) as TraitStep | null;
    if (step && step.node) nodes.push(step.node);
  }

  return { tags: ordered, nodes };
}
