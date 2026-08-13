/**
 * Tavily Search API client — built for AI agents
 * Free tier: 1,000 queries/month. No credit card required.
 * Docs: https://docs.tavily.com/docs/api-reference/endpoint/search
 */

const TAVILY_API_BASE = 'https://api.tavily.com/search';

export interface TavilyResult {
  title: string;
  url: string;
  description: string;
}

export async function tavilySearch(query: string, apiKey: string, timeout = 12000): Promise<TavilyResult[] | null> {
  try {
    const r = await fetch(TAVILY_API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'mythinknode/0.6',
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        include_answer: false,
        max_results: 10,
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!r.ok) return null;

    const body = await r.json() as {
      results?: Array<{ title: string; url: string; content: string }>;
    };

    const results = body.results ?? [];
    if (results.length === 0) return null;

    return results.map(r => ({
      title: r.title || '',
      url: r.url || '',
      description: (r.content || '').slice(0, 300),
    }));
  } catch {
    return null;
  }
}
