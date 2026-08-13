/**
 * 搜索路由提示词 — 每层一次 LLM 调用，匹配 keywords 选择节点。
 * 使用 deepseek-v4-flash，追求低延迟。
 */

export function buildSearchPrompt(query: string, menu: string): string {
  return `Query: "${query}"

Pick relevant nodes by ID. Match against keywords. Prefer the most specific match — if multiple nodes overlap, pick the one whose keywords most precisely match the query. If nothing clearly matches, return "none".

${menu}

Return ONLY comma-separated IDs, or "none".`;
}
