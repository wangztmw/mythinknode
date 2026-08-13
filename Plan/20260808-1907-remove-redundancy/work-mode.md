# 工作方式

## 当前依赖图

```
Mythinknode.ts ──→ agent_def.ts ──→ llm/types.ts (LLMClient)
    │                  │
    │                  └──→ cli/monitor/progress.ts (ProgressEvent)
    │                  │
    ├─→ session.ts ────→ llm/types.ts (ChatMessage)
    ├─→ session_loop.ts
    │       └──→ query_loop.ts ──→ agent_def.ts
    │                                  └──→ cli/monitor/progress.ts
    ├─→ config.ts (独立，无依赖)
    ├─→ cli/cli.ts
    │       └──→ cli/monitor/progress.ts
    └─→ llm/resolve.ts → llm/client.ts → llm/anthropic.ts | openai.ts

工具层:
  AgentTool ──→ agent_def.ts (MemberState + SUB_AGENT_PROMPT)
  WebSearchTool ──→ config.ts (loadConfig ← ⚠️ 绕过toolContext)
  其他 9 个工具 ──→ 只依赖 tools/core/Tool.ts ✅
```

## 修改后的依赖图

```
Mythinknode.ts ──→ agent_def.ts ──→ llm/types.ts
    │                  │
    │                  └──→ cli/monitor/progress.ts (不变)
    │
    ├─→ session.ts, session_loop.ts, config.ts (不变)
    ├─→ cli/cli.ts (不变)
    └─→ llm/resolve.ts (不变)

工具层:
  AgentTool ──→ agent_def.ts (MemberState, 不直接依赖 SUB_AGENT_PROMPT)
  WebSearchTool ──→ 只依赖 tools/core/Tool.ts (tavilyApiKey 走 toolContext)
  其他 9 个工具 ──→ 不变
```

## 改动汇总

| # | 文件 | 改动 | 行数 |
|---|------|------|------|
| 1 | `agent_def.ts` | 删 `private tools` 字段；改局部变量 | -1 |
| 2 | `agent_def.ts` | 构造时读 memory，删 buildSystemPrompt 里的 new ConfigStore | +1/-1 |
| 3 | `agent_def.ts` | toolContext.options 加 tavilyApiKey | +1 |
| 4 | `WebSearchTool.ts` | 删 loadConfig import，从 ctx.options 读 key | +1/-2 |
| 5 | `config.ts` | 删 `loadConfig()` 向后兼容导出（不再被引用） | -3 |
