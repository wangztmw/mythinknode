import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  url: z.string().describe('URL to fetch'),
  prompt: z.string().describe('What to extract from the page'),
});

export const WebFetchTool = buildTool({
  name: 'WebFetch',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call({ url, prompt }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    const start = Date.now();
    const timeout = 8000;
    try {
      const r = await fetch(url.startsWith('http') ? url : `https://${url}`, {
        headers: { 'User-Agent': 'mythinknode/0.2' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) return { data: `Fetch failed after ${Date.now() - start}ms: ${r.status}` };
      const html = await r.text();
      const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
      return { data: `${text}\n\n(Prompt: ${prompt})` };
    } catch (e) {
      const elapsed = Date.now() - start;
      const err = e as Error;
      const isTimeout = err.name === 'TimeoutError' || err.message.includes('abort');
      if (isTimeout) {
        return { data: `Fetch timed out after ${elapsed}ms (limit: ${timeout}ms). The site may be slow or unreachable. Retry with a different URL, or skip this source.` };
      }
      return { data: `Fetch error after ${elapsed}ms: ${err.message}` };
    }
  },
  async prompt() { return `## WebFetch\n${DESCRIPTION}\nInput: { url, prompt }`; },
  userFacingName: () => 'WebFetch',
  getToolUseSummary({ url }: Partial<z.infer<typeof inputSchema>>) { return url ? `Fetch: ${url}` : null; },
});
