export const DESCRIPTION = `Activate a callable tool stored in NodeMind knowledge.

When a Knowledge node contains a [config] attr (tool spec: toolName + description + JSON-schema parameters) AND a [code] attr (JS implementation), use this tool to compile and register it as a real callable tool.

Actions:
- **load**: nodeId → compile that node's config+code attrs into a Tool and register it. After loading, call it by its toolName like any other tool.
- **list**: show currently loaded dynamic tools.

The loaded tool runs in a vm sandbox with whitelisted helpers (analyzeImage, taskPrompt, ensureVisionServer, stopVisionServer, fetch, zod) — no fs/process/require access.`;
