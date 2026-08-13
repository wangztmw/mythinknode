import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';
import { loadConfig } from '../../../cli/config.js';
import { tavilySearch } from '../tavily.js';

const inputSchema = z.object({
  query: z.string().describe('Search query'),
});

const TIMEOUT = 12000;

// ---- DuckDuckGo fallback (scraping) ----

const UA_POOL = [
  'mythinknode/0.6',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

async function duckDuckGoSearch(query: string): Promise<string> {
  for (let i = 0; i < UA_POOL.length; i++) {
    try {
      const r = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': UA_POOL[i] },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!r.ok) continue;
      const html = await r.text();
      if (html.includes('captcha') || html.includes('429') || html.length < 200) continue;

      const results: string[] = [];
      const seen = new Set<string>();
      const re = /<a\s+rel="nofollow"\s+href="([^"]+)"[^>]*>([^<]+)<\/a>\s*(?:<span[^>]*>([^<]*)<\/span>)?/gi;
      let m;
      while ((m = re.exec(html)) !== null && results.length < 10) {
        const u = m[1]!, title = m[2]!.replace(/<[^>]*>/g, '').trim();
        const desc = (m[3] || '').replace(/<[^>]*>/g, '').trim();
        if (!title || seen.has(u)) continue;
        seen.add(u);
        results.push(`${title}\n  ${u}${desc ? `\n  ${desc.slice(0, 150)}` : ''}`);
      }
      if (results.length > 0) return results.join('\n\n');
    } catch (e) {
      if ((e as Error).name === 'TimeoutError') throw e;
    }
  }
  return `(no results for: ${query})`;
}

// ---- Formatting ----

function fmt(r: { title: string; url: string; description: string }): string {
  return `${r.title}\n  ${r.url}${r.description ? `\n  ${r.description}` : ''}`;
}

// ---- Tool ----

export const WebSearchTool = buildTool({
  name: 'WebSearch',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call({ query }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    const start = Date.now();
    const key = loadConfig().tavilyApiKey;

    // Tavily API
    if (key) {
      try {
        const results = await tavilySearch(query, key, TIMEOUT);
        if (results) return { data: results.map(fmt).join('\n\n') };
      } catch { /* fall through */ }
    }

    // DuckDuckGo fallback
    try {
      return { data: await duckDuckGoSearch(query) };
    } catch (e) {
      const elapsed = Date.now() - start;
      const err = e as Error;
      if (err.name === 'TimeoutError') {
        return { data: `Search timed out after ${elapsed}ms. Network may be slow. Retry or use prior knowledge.` };
      }
      return { data: `Search error after ${elapsed}ms: ${err.message}` };
    }
  },

  async prompt() { return `## WebSearch\n${DESCRIPTION}\nInput: { query }`; },
  userFacingName: () => 'WebSearch',
  getToolUseSummary({ query }: Partial<z.infer<typeof inputSchema>>) { return query ? `"${query.slice(0, 50)}"` : null; },
});
