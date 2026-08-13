import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';
import { getNodeMindStore, getSearchLLM } from '../../../nodemind/nodeMind_manage.js';
import { searchTree } from '../../../nodemind/preNavigator.js';

const inputSchema = z.object({
  action: z.enum(['search', 'read', 'browse']).describe('search=query one layer / read=full node / browse=children'),
  query: z.string().optional().describe('Search query'),
  nodeId: z.string().optional().describe('Node ID to read or browse'),
  from: z.array(z.string()).optional().describe('Node IDs to search from (default: root). Use to search deeper after a previous search.'),
  depth: z.number().optional().describe('Current search depth — used to show how deep you are (max 4)'),
});

export const KnowledgeTool = buildTool({
  name: 'Knowledge',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call(input: z.infer<typeof inputSchema>, ctx: ToolUseContext): Promise<ToolResult<string>> {
    const store = getNodeMindStore();
    const { action } = input;

    // ---- browse ----
    if (action === 'browse') {
      const nodeId = input.nodeId || 'root';
      const node = store.getNode(nodeId);
      if (!node) return { data: `Node "${nodeId}" not found.` };

      let result = `${node.children.length > 0 ? '📁' : '📋'} **${node.title}**\nkeywords: \`${node.keywords.join(', ')}\`\n${node.content.slice(0, 200)}`;

      if (node.attrs.length > 0) {
        result += `\n\n### Attrs (${node.attrs.length})`;
        for (const attr of node.attrs) {
          const kv = Object.keys(attr.fields).slice(0, 3).join(', ');
          result += `\n- **${attr.id}** [${attr.type}]: ${attr.title} {${kv}${Object.keys(attr.fields).length > 3 ? '...' : ''}}`;
        }
      }

      if (node.children.length > 0) {
        // 展示每个子节点的 keywords，从 keywordMap 可以看到去重后的覆盖
        const kwMap = store.getChildKeywordMap(nodeId);
        const flatKws = store.getChildKeywordsFlat(nodeId);
        result += `\n\n### Children (${node.children.length}) — all keywords: \`${flatKws.join(', ')}\``;
        for (const child of node.children) {
          result += `\n- **${child.id}**: ${child.title} — \`${child.keywords.join(', ')}\``;
        }
        result += `\n\nUse Knowledge(action='read', nodeId='...') for details.`;
      }

      return { data: result };
    }

    // ---- read ----
    if (action === 'read') {
      if (!input.nodeId) return { data: 'Error: nodeId required.' };
      const node = store.getNode(input.nodeId);
      if (!node) return { data: `Node "${input.nodeId}" not found.` };

      let result = `## ${node.title}\n**ID:** ${node.id}\n**Keywords:** ${node.keywords.join(', ')}\n**Updated:** ${node.updatedAt}\n\n${node.content}`;

      if (node.attrs.length > 0) {
        result += '\n\n---\n### Attached Data';
        for (const attr of node.attrs) {
          result += `\n\n**${attr.title}** [${attr.type}]\n${attr.content}`;
          for (const [k, v] of Object.entries(attr.fields)) result += `\n  ${k}: ${v}`;
        }
      }

      if (node.children.length > 0) {
        result += '\n\n---\n### Children';
        for (const child of node.children) result += `\n- **${child.id}**: ${child.title} — \`${child.keywords.join(', ')}\``;
      }

      return { data: result };
    }

    // ---- search ----
    if (!input.query) return { data: 'Error: query required for search.' };
    const llm = getSearchLLM() || (ctx.engine as any)?.llm;
    if (!llm) return { data: 'LLM not available.' };

    try {
      const fromIds = input.from && input.from.length > 0 ? input.from : ['root'];
      const depth = input.depth || 0;
      if (depth >= 4) return { data: 'Max depth reached (4). Use Knowledge(action=\'read\') on specific nodes for details.' };

      const result = await searchTree(input.query, store, llm, fromIds);

      if (result.matches.length === 0) {
        return { data: `No matches for "${input.query}" at this layer. Use Knowledge(action='browse') to explore, or try different keywords.` };
      }

      // 只返回匹配列表（不含 content）→ Agent 用 read 逐个读
      let response = `## ${result.matches.length} matches (layer ${depth + 1}) for: "${input.query}"\n\n`;
      for (const m of result.matches) {
        const badges: string[] = [];
        if (m.hasAttrs) badges.push(`${m.attrCount} attrs`);
        if (m.hasChildren) badges.push(`${m.childCount} children`);
        const badge = badges.length > 0 ? ` (${badges.join(', ')})` : '';
        response += `- **${m.id}**: ${m.title}${badge}\n  keywords: ${m.keywords.join(', ')}\n  ${m.summarySnippet}...\n\n`;
      }
      response += `Read ONE at a time: Knowledge(action='read', nodeId='...').`;

      if (result.deeperIds.length > 0) {
        response += `\n\n> 💡 Some matches have deeper children. Search deeper: Knowledge(action='search', query='${input.query}', from=${JSON.stringify(result.deeperIds)}, depth=${depth + 1})`;
      }
      return { data: response };
    } catch (e) {
      return { data: `Search error: ${(e as Error).message}` };
    }
  },

  async prompt() { return `## Knowledge\n${DESCRIPTION}\nInput: { action: 'search'|'read'|'browse', query?, nodeId?, from?, depth? }`; },
  userFacingName: () => 'Knowledge',
  getToolUseSummary(input: Partial<z.infer<typeof inputSchema>>) {
    if (input.action === 'browse') return `Knowledge: browse ${input.nodeId || 'root'}`;
    if (input.action === 'read') return `Knowledge: read ${input.nodeId || ''}`;
    const depthTag = input.depth ? ` L${input.depth + 1}` : '';
    return input.query ? `Knowledge: "${input.query.slice(0, 40)}"${depthTag}` : 'Knowledge';
  },
});
