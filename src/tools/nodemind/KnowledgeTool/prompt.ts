export const DESCRIPTION = `Use when you need to find past experience — how a similar task was solved, what tools worked, what pitfalls exist. Do NOT use for facts you already know or simple lookups (use Read/Grep for that).

Searches ONE layer at a time. Try results first — only search deeper if they don't solve the problem.

Actions:
- **search**: Match query against keywords at current layer. Returns match list (id + keywords + snippet) — then read nodes one at a time.
- **read**: Load a node's full content + all attrs with their field values. Use after search to get details.
- **browse**: See a node's keywords, its children's keywords (deduplicated), and its attrs. Use to explore what's available.

Search deeper: Knowledge(action='search', from=['nodeId'], depth=N). Max depth 4.`;
