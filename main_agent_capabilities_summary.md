# Main Agent Capabilities Summary

*Generated from source code analysis — mythinknode v0.6.0*

---

## 1. Tools (11 total)

All tools defined in `src/tools/core/index.ts` via `getAllTools()`. Each has an `isEnabled()` check.

| # | Tool Name | Internal Name | Category | Description |
|---|-----------|---------------|----------|-------------|
| 1 | **Bash** | `BashTool` | exec | Run shell commands, background tasks supported |
| 2 | **Read** | `FileReadTool` | file | Read file contents with offset/limit |
| 3 | **Write** | `FileWriteTool` | file | Create or overwrite files |
| 4 | **Edit** | `FileEditTool` | file | In-place string replacement (single or all occurrences) |
| 5 | **Glob** | `GlobTool` | file | Glob pattern file search |
| 6 | **Grep** | `GrepTool` | file | Regex pattern search with context |
| 7 | **WebSearch** | `WebSearchTool` | search | Web search via Tavily API |
| 8 | **WebFetch** | `WebFetchTool` | search | Fetch and extract content from URLs |
| 9 | **MCP** | `MCPTool` | external | MCP server integration (arbitrary server/tool calls) |
| 10 | **Skill** | `SkillTool` | external | Invoke named skills with optional arguments |
| 11 | **Agent** | `AgentTool` | agent | Sub-agent orchestration: `spawn`, `check`, `wait_any`, `direct`, `kill` |

---

## 2. Query Loop (`agentLoop` in `query_loop.ts`)

### Architecture

```
┌─────────────────────────────────────────────────┐
│  for (i = 0; i < maxRounds; i++)               │
│    ┌─ preRoundCheck() → signal? → exit        │
│    └─ llm.chat(messages, systemPrompt)         │
│         ├─ stop_reason = 'end_turn' → DONE     │
│         └─ stop_reason = 'tool_use'            │
│              ├─ extract thoughts                │
│              ├─ executeTools() (parallel)       │
│              ├─ pushResults() to messages       │
│              └─ continue loop                   │
└─────────────────────────────────────────────────┘
```

### Key Details

- **System Prompt**: Built dynamically in `AgentEngine.buildSystemPrompt()` — includes CWD, date, OS, user memory (`~/.mythinknode/MYTHINKNODE.md`), orchestration rules, and the full tool list.
- **Stop Reasons**: `end_turn` (agent finished, success), `tool_use` (needs tools executed). Unknown stop reasons → `crashed`.
- **Thought Extraction**: Parsed from assistant text blocks; supports `[FEEDBACK: xxx]` and `[BLOCKED: xxx]` markers.
- **Tool Execution**: Parallel by default (`Promise.all`); serial mode available via `serialTools` param.
- **Tool Timeout**: 30 seconds per tool call. Timeout does NOT abort the tool — agent gets a message to "check next round."
- **Heartbeat**: 100ms ticks pushed to `engine.events` for CLI live rendering.
- **Tool Merge**: Consecutive calls to the same tool are merged in display (counts, summaries, sample lines).

### Loop Results
| Status | Trigger |
|--------|---------|
| `success` | `stop_reason === 'end_turn'` |
| `blocked` | `preRoundCheck` returns `BLOCKED:...` or `blocked:...` |
| `killed` | `preRoundCheck` returns `(killed)` / `killed...` |
| `crashed` | LLM call exception or unexpected `stop_reason` |
| `max_rounds` | Loop exhausted without `end_turn` |

---

## 3. Session Loop (`runSession` in `session_loop.ts`)

Wraps `agentLoop` with:

1. **Flush notifications** from background agents into messages.
2. **First `agentLoop`**: `maxRounds = 25`.
3. **Post-loop guard**: If background agents (`engine.team`) are still `running`, wait up to 120s (poll every 500ms), then run a second `agentLoop` with `maxRounds = 8` to summarize results.
4. **Token tracking**: Cumulative tokens stored in `session.cumulativeTokens` with `tokenMarkers` snapshots.
5. **Message compression** (`MessageProcessor`): On success, compress the delta messages to save context.
6. **Task continuation**: If `max_rounds` is hit, `taskStartLen` preserves the starting index so "continue" reuses the same task window.

---

## 4. LLM Models Supported

| Provider | Key Prefix | Default Model | Default Base URL |
|----------|-----------|---------------|------------------|
| **Anthropic** | `sk-ant-` | `claude-sonnet-5-20251001` | (native API) |
| **OpenAI-compatible** | `sk-` | `deepseek-chat` | `https://api.deepseek.com` |

- Auto-detected from API key prefix.
- Configurable via `~/.mythinknode/config.json` or environment variables (`MYTHINKNODE_MODEL`, `OPENAI_BASE_URL`).
- Any OpenAI-compatible endpoint can be used by setting `openaiBase`.

---

## 5. Limits & Constraints

| Limit | Value | Location |
|-------|-------|----------|
| **Max rounds (initial)** | 25 | `session_loop.ts` |
| **Max rounds (post-agent summary)** | 8 | `session_loop.ts` |
| **LLM concurrency** | 2 (shared by all agents) | `llm/client.ts` → `ConcurrencyLimiter(2)` |
| **Concurrency queue timeout** | 120 seconds | `llm/concurrency.ts` |
| **Tool execution timeout** | 30 seconds | `query_loop.ts` → `TOOL_TIMEOUT_MS` |
| **Background agent wait** | 120 seconds (poll 500ms) | `session_loop.ts` |
| **Max wait_any batches** | 3 (per system prompt rules) | `agent_def.ts` system prompt |
| **Web tool retries** | 2 failures → stop (sub-agent rule) | `agent_def.ts` → `SUB_AGENT_PROMPT` |
| **Session storage** | `~/.mythinknode/sessions/` | `session/session.ts` |
| **Config storage** | `~/.mythinknode/config.json` | `cli/config.ts` |
| **User memory** | `~/.mythinknode/MYTHINKNODE.md` | `cli/config.ts` |

### Token Budget
- No hard token budget cap — tokens are tracked cumulatively in `session.cumulativeTokens`.
- Message compression runs after each successful session to keep context manageable.
- `tokenMarkers` array records snapshots of cumulative usage.

---

## 6. System Prompt Highlights

From `AgentEngine.buildSystemPrompt()`:

- **Identity**: "You are mythinknode, an AI coding assistant. Always respond in English. Be concise and direct."
- **Orchestration-first**: "Your job is orchestration and synthesis. Don't search, read files, or write code yourself — delegate to Agents."
- **Agent dispatch rule**: Complex tasks → decompose by domain → dispatch one Agent per domain in parallel.
- **Wait pattern**: After dispatch → `wait_any` → `check` reports → max 3 batches → synthesize.
- **Sub-agent communication**: Sub-agents write `[NEED: xxx]` / `[FOUND: xxx]` markers; main agent routes info via `check`/`direct`.
- **File rules**: "Read before editing. Use Edit for small changes. Don't use cat/head/tail/sed/awk — use Read/Edit."
- **Context tags**: `[S1]`, `[S2]` etc. are compressed summaries; originals in `raws/S{n}.json`.

---

## 7. Sub-Agent Prompt (`SUB_AGENT_PROMPT`)

- Complete assigned task, return concise report.
- Web tools fail 2+ times → stop, rely on existing knowledge.
- Don't retry failed network calls.
- Don't ask questions.
- Use `[NEED: ...]` and `[FOUND: ...]` markers for inter-agent communication.
- Self-check: `[CHECKLIST]` with `[x]` / `[ ]` markers.
- End with `[DONE]` / `[PARTIAL:reason]` / `[BLOCKED:reason]`.

---

## 8. Session Persistence

- Sessions saved to `~/.mythinknode/sessions/{id}/session.json`.
- Lock file prevents concurrent sessions (`~/.mythinknode/sessions/.lock`).
- Resume with `--resume` / `-r` flag; interactive picker if multiple sessions exist.
- On `/exit`, LLM summarizes conversation → directory renamed with topic prefix.
- Corrupted sessions silently skipped; failed summaries fall back to timestamp names.
