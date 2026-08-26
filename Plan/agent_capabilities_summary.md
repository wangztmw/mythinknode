# Agent System Capabilities — Comprehensive Summary

## 1. The Five Actions

The `Agent` tool exposes five actions for agent orchestration. All go through a single tool
(`AgentTool`) with `zod` validation and a `z.enum` schema.

| Action | Purpose | Required Fields | Effect |
|--------|---------|----------------|--------|
| `spawn` | Launch a sub-agent | `description`, `prompt` | Creates a `MemberState` entry, runs `agentLoop()` asynchronously (or synchronously if `background` is false/omitted). |
| `check` | Read a sub-agent's full report and live status | `taskId` | Looks up the agent by ID in `engine.team`, returns status, round count, tool count, last output, and any feedback. |
| `wait_any` | Block until at least one agent finishes / blocks / fails | *(optional)* `timeout_ms` (default 15000) | Polls `engine.team` every 500ms. Returns immediately if any agent is non-running. Lists counts by status and shows the most recently changed member. |
| `direct` | Inject a new instruction into a running agent | `taskId`, `instruction` | Sets `pendingInstruction` on the member. On the next `preRoundCheck` tick, the instruction is injected as a user message prefixed with `"🔔 主Agent指令（最高优先级，按此执行）:"`. Only works if status is `'running'`. |
| `kill` | Forcibly stop a running agent | `taskId` | Calls `AbortController.abort()`, sets `status = 'killed'`, records `endTime`. The agent loop detects the abort in `preRoundCheck` and stops. |

---

## 2. What Tools Sub-Agents Have Access To

Sub-agents run inside the **same** `AgentEngine` instance as the main agent. This means
they share the exact same `engine.toolMap` — all 11 tools:

| Tool | Purpose |
|------|---------|
| `Bash` | Execute shell commands (`run_in_background` supported) |
| `Read` | Read files with offset/limit |
| `Write` | Write files atomically |
| `Edit` | Find-and-replace in files |
| `Glob` | File pattern matching |
| `Grep` | Regex search across files |
| `WebSearch` | Web search |
| `WebFetch` | Fetch and extract from URLs |
| `MCP` | MCP server integration |
| `Skill` | Invoke named skills |
| `Agent` | **Recursive agent spawning** — sub-agents can spawn their own sub-agents |

**Key differences** for sub-agents:
- `systemPrompt`: `SUB_AGENT_PROMPT` (tells them they are sub-agents, gives them the `[NEED]`/`[FOUND]` communication protocol, mandates `[DONE]`/`[PARTIAL]`/`[BLOCKED]` endings).
- `maxRounds`: **10** (hard limit; `max_rounds` status returned if exhausted).
- `serialTools`: **`true`** — tools execute one at a time (no parallel tool calls per turn).
- They do NOT have the orchestration rules the main agent has; they are told to *execute tasks*, not orchestrate.

---

## 3. How Orchestration Works

### The Main Agent's Orchestration Rules (injected via `buildSystemPrompt`)

The main agent's system prompt includes explicit orchestration directives:

1. **Dispatch pattern**: Complex tasks → decompose by domain → one `Agent(action='spawn', background=true)` per domain.
2. **Wait pattern**: After dispatching → immediately `Agent(action='wait_any', timeout_ms=15000)` to return on first completion.
3. **Check then decide**: After wait_any → `Agent(action='check', taskId=...)` to read reports, or continue `wait_any`.
4. **Batch limit**: Max **3 batches** of `wait_any`. After that, synthesize whatever is available.
5. **Blocked agents**: Check feedback → `direct` (redirect) or `kill` + re-spawn.
6. **Information routing**: Sub-agents write `[NEED: xxx]` / `[FOUND: xxx]` markers. The main agent reads these via `check` and routes info between agents.
7. **Delegation mandate**: The main agent is told *not* to do work itself — delegate everything to agents. Unsatisfactory results → re-spawn with more precise prompt.

### The Main Loop (`agentLoop`)

A single `agentLoop()` function (`query_loop.ts`) drives both main and sub-agents. The differences come purely from `AgentLoopParams`:

```
for round 0..maxRounds:
  preRoundCheck(messages)  →  BLOCKED? killed? pendingInstruction?
  llm.chat(messages, systemPrompt)
  if end_turn → success, return
  if tool_use  → executeTools(engine, response, updateStats, serialTools)
                 push results into messages
                 continue loop
```

`preRoundCheck` is the hook that enables:
- **Status polling**: checking if the agent was killed or blocked between rounds.
- **Instruction injection**: `pendingInstruction` is pushed as a user message and cleared.
- **Abort detection**: if `abortController.signal.aborted`, the loop exits with `'killed'`.

### Communication Protocol (Sub → Main)

Sub-agents can write markers in their *thinking* (the text portion of the LLM response before tool calls):

| Marker | Meaning |
|--------|---------|
| `[NEED: ...]` | Sub-agent requests data or help from the main agent |
| `[FOUND: ...]` | Sub-agent alerts the main agent to a discovery |
| `[FEEDBACK: ...]` | General feedback (parsed by `updateStats`) |
| `[BLOCKED: ...]` | Sub-agent reports it is stuck; status becomes `'blocked'`, `onNotify` fires |
| `[DONE]` | Task completed, checklist verified |
| `[PARTIAL: reason]` | Task partially done |
| `[BLOCKED: reason]` | Task cannot proceed |
| `[CHECKLIST]` | Self-check before reporting |

All feedback triggers `engine.onNotify?.(...)` which alerts the main agent.

---

## 4. Concurrency Limits & Configuration

### Concurrency
- **No hard concurrency limit** on spawned agents. The `team` Map can hold any number.
- Agents are spawned via `agentLoop(engine, subConfig)` — in background mode this is a fire-and-forget Promise.
- A small jitter (`Math.random() * 500ms`) is added before background spawn to stagger launches.
- `isConcurrencySafe: () => true` — the Agent tool itself is marked concurrency-safe.

### Round Limits
- **Sub-agents: 10 rounds max** (configurable via `maxRounds` in `AgentLoopParams`).
- **Main agent**: determined by the session configuration, typically higher.

### Tool Execution Mode
- **Sub-agents**: `serialTools = true` — tools execute one at a time per round.
- **Main agent**: may support parallel tool calls.

### wait_any Timeout
- Default: **15000ms** (15 seconds).
- Configurable per call via `timeout_ms`.
- Polls every 500ms.

### Batch Limit
- Main agent is instructed to limit to **3 batches** of `wait_any` before synthesizing results.

---

## 5. Relationship: Main Agent ↔ Sub-Agents

### Architecture

```
┌──────────────────────────────────────┐
│           AgentEngine (singleton)    │
│  ┌────────────────────────────────┐  │
│  │  team: Map<string, MemberState>│  │
│  │  toolMap: Map<string, Tool>    │  │  ← shared by ALL agents
│  │  llm: LLMClient                │  │
│  │  systemPrompt (main)            │  │
│  │  onNotify callback             │  │
│  └────────────────────────────────┘  │
│                                      │
│  Main Agent Loop                     │
│  ├─ systemPrompt: buildSystemPrompt()│
│  ├─ calls AgentTool (spawn/check/…)  │
│  │   └─ creates sub-agent via        │
│  │      agentLoop(engine, subConfig)  │
│  │                                    │
│  Sub-Agent Loop                       │
│  ├─ systemPrompt: SUB_AGENT_PROMPT   │
│  ├─ maxRounds: 10                    │
│  ├─ serialTools: true                │
│  └─ Can spawn MORE sub-agents        │
│      (recursive, same engine)        │
└──────────────────────────────────────┘
```

### MemberState Lifecycle

```
pending → running → completed   (success)
                  → blocked     (needs intervention)
                  → failed      (error/crash)
                  → killed      (main agent terminated it)
```

Each `MemberState` carries:
- `id`: unique ID (prefix `a` for agents, `b` for bash tasks)
- `status`, `subject`, timing (`startTime`, `endTime`)
- `output`: full output text (stored, not truncated)
- `feedback`: any `[BLOCKED]`/`[FEEDBACK]` marker from sub-agent
- `abortController`: for kill support
- `agentLoop`: live stats (`roundCount`, `toolUseCount`, `lastActivity`, `lastOutput`)
- `pendingInstruction`: queued instruction from `direct`

### Key Design Points

1. **Shared engine, different configs**: Main and sub-agents use the same `agentLoop` function and `AgentEngine`. Only `AgentLoopParams` differ (`systemPrompt`, `maxRounds`, `serialTools`, `preRoundCheck`).

2. **Recursive spawning**: Sub-agents have the `Agent` tool, so they can spawn their own sub-agents. There is no depth limit enforced.

3. **Main agent as orchestrator**: The main agent's system prompt explicitly tells it to *orchestrate and synthesize*, not to do work directly. "Don't search, read files, or write code yourself — delegate to Agents."

4. **Information routing**: The `[NEED]`/`[FOUND]` protocol enables cross-agent communication mediated by the main agent. Sub-agents never talk to each other directly.

5. **Blocked → redirect pattern**: When a sub-agent reports `[BLOCKED: reason]`, the main agent can `direct` a new instruction or `kill` and re-spawn with a better prompt.

6. **Transient notifications**: `engine.onNotify` fires on agent completion/blocking. The notification includes a prompt to use `Agent(action='check')` to read the report — reports are not delivered inline; the main agent must explicitly check.

7. **Synchronous vs Background**: `spawn` with `background=true` runs asynchronously and returns immediately with the agent ID. Without `background`, the main agent blocks until the sub-agent finishes (synchronous delegation).
