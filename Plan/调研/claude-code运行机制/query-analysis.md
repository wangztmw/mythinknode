# query.ts Analysis: The Core LLM Interaction Loop of Claude Code

**Source:** `/Users/Zhuanz1/Desktop/CLit/study/claude-code/claude-code-main/src/query.ts`
**Lines:** 1730
**Analysis date:** 2026-08-04

---

## 1. Function Signature and Parameters

### Top-Level: `query()` (lines 219-239)

```typescript
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal
>
```

This is the public entry point. It wraps `queryLoop()` and adds command lifecycle notification on normal completion (lines 235-237): it calls `notifyCommandLifecycle(uuid, 'completed')` for each consumed command UUID.

### Inner Loop: `queryLoop()` (lines 241-251)

```typescript
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage, Terminal>
```

### `QueryParams` (lines 181-199)

| Param | Type | Description |
|-------|------|-------------|
| `messages` | `Message[]` | The full conversation history |
| `systemPrompt` | `SystemPrompt` | The system prompt (branded type via `asSystemPrompt`) |
| `userContext` | `{[k: string]: string}` | User context variables interpolated into the prompt |
| `systemContext` | `{[k: string]: string}` | System context appended to system prompt |
| `canUseTool` | `CanUseToolFn` | Permission check function -- determines if a tool is allowed |
| `toolUseContext` | `ToolUseContext` | Full tool execution context (tools list, abort controller, agent ID, options, etc.) |
| `fallbackModel` | `string?` | Optional model to fall back to on overload |
| `querySource` | `QuerySource` | Identifies who initiated this query (REPL, SDK, agent, compact, etc.) |
| `maxOutputTokensOverride` | `number?` | Override for max output tokens |
| `maxTurns` | `number?` | Maximum number of tool-use turns before forced stop |
| `skipCacheWrite` | `boolean?` | Whether to skip prompt cache writes |
| `taskBudget` | `{total: number}?` | Beta task-budgets-2026-03-13 API feature |
| `deps` | `QueryDeps?` | Dependency injection (defaults to `productionDeps()`) for testability |

---

## 2. Main Loop Structure

### The Loop: `while (true)` (line 307)

The loop is an **infinite while-true** with numerous `continue` and `return` exit points. It is NOT bounded by a `for` counter -- instead, it is bounded by:

1. **No tools used** (`needsFollowUp === false`) -- the model gave a final answer, loop exits (line 1062)
2. **maxTurns exceeded** (line 1705) -- hard limit on tool-use rounds
3. **User abort** (`abortController.signal.aborted`) -- mid-stream (line 1015) or mid-tool (line 1485)
4. **Stop hooks prevent continuation** (lines 1278, 1519)
5. **Error conditions** -- prompt too long (line 1175), image error (line 1175), model error (line 996), blocking limit (line 646)

### State Machine Pattern (lines 204-217, 268-279)

All mutable state is encapsulated in a single `State` type and updated atomically:

```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined    // Why the previous iteration continued
}
```

Instead of mutating individual fields, every continue site does:

```typescript
const next: State = { ...allFields, changedField: newValue }
state = next
continue
```

This is a **functional/immutable state update pattern** that makes it easy to reason about state transitions and impossible to forget to update a field. There are **7 continue sites** total (see Section 7).

At the top of each iteration (lines 311-321), state is destructured for convenient bare-name access throughout the loop body.

---

## 3. Tool Call Execution

### Overview

Tool execution happens in two phases:

**Phase 1: During streaming** (lines 838-862) -- `StreamingToolExecutor` runs tools as soon as their `tool_use` blocks arrive in the stream. Completed results are yielded immediately.

**Phase 2: After streaming** (lines 1366-1408) -- Remaining tools (those that didn't finish during streaming) are executed via `streamingToolExecutor.getRemainingResults()` or the synchronous fallback `runTools()`.

### The Two Paths (lines 1366-1408)

```typescript
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()   // Path A: streaming executor
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)  // Path B: traditional
```

Path A (`StreamingToolExecutor`) is the newer, feature-gated path. Path B (`runTools`) is the traditional synchronous approach.

### Where `canUseTool` Fits In

`canUseTool` (typed as `CanUseToolFn` from `./hooks/useCanUseTool.js`) is the permission gate. It is passed into:

1. `StreamingToolExecutor` constructor (line 563-566) during setup
2. `runTools()` directly (line 1382) in the traditional path

The tool executor calls `canUseTool` before each tool invocation. If it returns `false`, the tool is skipped and an error tool_result is generated. This is how the permission system (allow/deny/ask) integrates into the loop.

### Tool Result Normalization (lines 1395-1399)

After tools execute, results are normalized through `normalizeMessagesForAPI()` which converts the raw tool results into the `tool_result` content blocks that the Anthropic API expects.

---

## 4. Tool Results Fed Back to LLM

### The Continue Site (lines 1714-1727)

At the end of the loop, when tools have produced results, the state is updated:

```typescript
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  ...
}
state = next
```

The `messages` array now contains: previous messages + assistant response + tool results. On the next iteration, `messagesForQuery` is rebuilt from this (line 365), and the LLM sees the assistant's tool_use blocks paired with tool_result blocks. This follows the standard Anthropic tool-use protocol.

### Attachment Injection (lines 1550-1590)

Between the LLM response and the next turn, additional context is injected as attachments:

- **Queued commands** (lines 1570-1578): Snapshot of the message queue, filtered by agent ID and priority
- **Memory prefetch results** (lines 1599-1614): Relevant memories from the memory system, deduplicated against already-read files
- **Skill discovery** (lines 1620-1628): Prefetched skill suggestions

All of these become `toolResults` (user messages with attachment content) that are appended before the next LLM call.

---

## 5. Streaming: The AsyncGenerator Pattern

### Yield Types

The generator yields a union of several types (line 221-227):

| Type | When |
|------|------|
| `StreamEvent` | Fine-grained streaming events (text deltas, etc.) |
| `RequestStartEvent` | Before each API call (line 337: `yield { type: 'stream_request_start' }`) |
| `Message` | Assistant messages, user messages, system messages |
| `TombstoneMessage` | Orphaned messages to remove from UI (fallback/retry) |
| `ToolUseSummaryMessage` | Generated tool-use summaries for mobile UI |

### Return Type: `Terminal`

The generator **returns** a `Terminal` object (not yields it) when done. The terminal reason tells the caller why the loop stopped:

- `'completed'` -- normal completion
- `'max_turns'` -- hit the turn limit
- `'aborted_streaming'` / `'aborted_tools'` -- user interrupted
- `'blocking_limit'` -- context over hard limit
- `'prompt_too_long'` -- API rejected the prompt
- `'image_error'` -- image validation/resize failure
- `'model_error'` -- unexpected runtime error
- `'stop_hook_prevented'` / `'hook_stopped'` -- hooks blocked continuation
- `'collapse_drain_retry'` -- (internal, not terminal -- continues loop)

### The Inner Streaming Loop (lines 659-863)

```typescript
for await (const message of deps.callModel({...})) {
    // Per-chunk processing
}
```

`deps.callModel()` returns an `AsyncGenerator` that yields chunks as they arrive from the API. Each chunk is processed:

1. **Fallback handling** (lines 712-741): If a streaming fallback occurred (model was swapped mid-stream), tombstone the orphaned messages and reset all arrays
2. **Backfill observable inputs** (lines 748-787): Clone tool_use blocks and backfill derived fields before yielding to consumers. The original is kept untouched for API compatibility (byte-level prompt caching)
3. **Error withholding** (lines 799-822): Recoverable API errors (prompt-too-long, max-output-tokens, media-size errors) are NOT yielded to consumers immediately. Instead, they're pushed to `assistantMessages` and checked after the stream completes so recovery paths can run first
4. **Tool execution during stream** (lines 838-862): As `tool_use` blocks arrive, `StreamingToolExecutor.addTool()` is called, and any completed results from `getCompletedResults()` are yielded immediately

---

## 6. Message Lifecycle Inside This Function

### Full Lifecycle Per Turn

```
1. EXTRACTION
   messagesForQuery = getMessagesAfterCompactBoundary(messages)
                                              |
2. PREPROCESSING (before API call)
   ├── applyToolResultBudget()          -- truncate large tool results
   ├── snipCompactIfNeeded()            -- remove old tool results (HISTORY_SNIP)
   ├── microcompact()                   -- cached message deduplication
   ├── applyCollapsesIfNeeded()         -- context collapse projection
   ├── autocompact()                    -- full context compaction
   ├── token limit check                -- hard blocking limit
   └── createDumpPromptsFetch           -- debug dump wrapper
                                              |
3. API CALL (deps.callModel)
   ├── yield RequestStartEvent
   ├── for each chunk:
   │   ├── handle fallback -> tombstone orphans
   │   ├── backfill observable inputs
   │   ├── withhold recoverable errors
   │   ├── yield message to consumer
   │   ├── collect assistantMessages
   │   ├── collect toolUseBlocks
   │   └── run streaming tools -> yield results
   └── yield deferred microcompact boundary
                                              |
4. POST-STREAMING
   ├── handle abort -> synthetic tool_results
   ├── yield pending tool use summary (from previous turn)
   ├── if !needsFollowUp:
   │   ├── try collapse drain (413 recovery)
   │   ├── try reactive compact (413 recovery)
   │   ├── try max_output_tokens escalation (8k -> 64k)
   │   ├── try max_output_tokens recovery (continue message)
   │   ├── handle stop hooks
   │   ├── check token budget
   │   └── return Terminal
   └── if needsFollowUp:
       ├── execute remaining tools
       ├── yield tool results
       ├── inject attachments (queued commands, memories, skills)
       ├── refresh MCP tools
       ├── check maxTurns
       └── continue loop (new State, back to step 1)
```

### Message Array Composition

At the continue site (line 1716):
```typescript
messages: [...messagesForQuery, ...assistantMessages, ...toolResults]
```

- `messagesForQuery`: All messages up to (but not including) the current assistant response
- `assistantMessages`: The model's response(s) from this iteration (text + tool_use blocks)
- `toolResults`: Tool results + attachments + memories + skill suggestions

These are the **API-side messages**. The REPL/session array is separate -- single-turn messages (tool_results, non-final text) are ephemeral in the API stream.

### The `transition` Field

Each continue site sets a `transition` on the State (line 216). This is a `Continue` discriminated union that records WHY the loop continued. Used primarily for tests to assert that recovery paths fired without inspecting message contents. Values include:
- `{reason: 'next_turn'}` -- normal tool-use continuation
- `{reason: 'max_output_tokens_recovery', attempt: N}` -- hit token cap, injected continue message
- `{reason: 'max_output_tokens_escalate'}` -- escalated from 8k to 64k output tokens
- `{reason: 'stop_hook_blocking'}` -- stop hook injected feedback
- `{reason: 'collapse_drain_retry', committed: N}` -- context collapse freed messages
- `{reason: 'reactive_compact_retry'}` -- reactive compaction ran
- `{reason: 'token_budget_continuation'}` -- token budget nudge

---

## 7. Clever Algorithms and Patterns

### 7.1 Feature-Flagged Code Loading (lines 14-21, 66-72, 114-121)

Uses `bun:bundle`'s `feature()` macro for tree-shakeable feature gating. Code is conditionally `require()`d so it's excluded from external (non-Ant) builds entirely:

```typescript
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as ...)
  : null
```

This means production bundles don't include experimental/ant-only code paths. The `feature()` function is evaluated at bundle time (not runtime) by Bun's bundler.

### 7.2 Atomic State Updates (lines 1099-1114 and 7 continue sites)

Every loop continuation creates a complete new `State` object rather than mutating fields. This is a **functional/immutable state machine** pattern. Seven continue sites:

| Site | Line | Reason |
|------|------|--------|
| 1 | 1099-1115 | Collapse drain retry (413 recovery) |
| 2 | 1152-1165 | Reactive compact retry (413/media recovery) |
| 3 | 1207-1220 | Max output tokens escalate (8k -> 64k) |
| 4 | 1231-1251 | Max output tokens recovery (continue message) |
| 5 | 1283-1305 | Stop hook blocking error feedback |
| 6 | 1321-1339 | Token budget continuation nudge |
| 7 | 1715-1727 | Normal next-turn continuation |

### 7.3 Error Withholding Pattern (lines 795-825)

Recoverable API errors are NOT yielded to consumers during streaming. Instead they're pushed to `assistantMessages` and checked after the stream completes. Four withhold types:

1. **contextCollapse withheld** (line 802): Collapse sees a 413 error in the stream but wants to try draining staged collapses first
2. **reactiveCompact withheld** (lines 811-813): Reactive compact wants to try a full compaction before surfacing the error
3. **Media size withheld** (lines 815-819): Image too large -- reactive compact can strip and retry
4. **Max output tokens withheld** (lines 820-822): May be recoverable via escalation or continue message

If all recovery paths fail, the withheld message is finally yielded (lines 1173, 1180, 1255).

### 7.4 Recovery Chain for Prompt-Too-Long (lines 1065-1183)

The 413 recovery is a cascading chain of increasingly aggressive strategies:

```
1. Collapse drain (cheap, keeps granular context)
   └─ Drain all staged context collapses, retry
2. Reactive compact (expensive, produces summary)
   └─ Full context compaction, retry
3. Surface error (all else failed)
   └─ Yield the withheld error, call stop-failure hooks
```

Each strategy is tried exactly once per error (guarded by `state.transition` or `hasAttemptedReactiveCompact`).

### 7.5 Model Fallback (lines 893-951)

When `FallbackTriggeredError` is caught and a `fallbackModel` is configured:

1. Switch `currentModel` to the fallback
2. Yield synthetic error tool_results for orphaned tool_use blocks (using `yieldMissingToolResultBlocks`)
3. Reset all assistant/tool arrays
4. Discard and recreate `StreamingToolExecutor`
5. Strip signature blocks (thinking signatures are model-bound)
6. Yield a system message about the switch
7. `continue` to retry the full API call

### 7.6 Max Output Tokens Escalation (lines 1188-1221)

A CACHED_MAY_BE_STALE feature flag `tengu_otk_slot_v1` controls whether the default 8k output token cap escalates to 64k (`ESCALATED_MAX_TOKENS`) on first hit. If escalation still hits the cap, it falls through to multi-turn recovery (injects "pick up where you left off" message, up to `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` times).

### 7.7 Memory/Skill Prefetch with Disposables (lines 300-335)

Uses TC39 `using` keyword for `pendingMemoryPrefetch`:

```typescript
using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
  state.messages,
  state.toolUseContext,
)
```

The prefetch fires at entry and resolves during model streaming. On all generator exit paths (return, throw, yield-return), `using` calls the disposable's cleanup. The consume point (line 1600) checks `settledAt !== null` -- non-blocking, retries on future iterations if not settled yet.

Skill discovery works similarly (line 331) but runs per-iteration with a guard that returns early on non-file-write iterations.

### 7.8 Token Budget Tracker (lines 1308-1355)

Feature-gated (`TOKEN_BUDGET`) system that:
- Tracks cumulative token usage per turn via `budgetTracker` and `checkTokenBudget()`
- Can inject a nudge message ("continue?") at percentage thresholds
- Can early-stop on diminishing returns
- Resets on compaction boundaries
- Only fires when `needsFollowUp === false` (model thinks it's done)

### 7.9 Tool Result Budgeting (lines 369-394)

Before the API call, `applyToolResultBudget()` truncates large tool results to stay within per-message limits. Tools with `maxResultSizeChars` set to `Infinity` are exempt. This runs BEFORE microcompact so content replacement is transparent to cached microcompact (which operates by tool_use_id, not content inspection).

### 7.10 Compaction Boundary Handling

Multiple compaction layers run in sequence before each API call (lines 365-543):

```
getMessagesAfterCompactBoundary()   -- only consider messages after last compact
applyToolResultBudget()             -- truncate large tool results
snipCompactIfNeeded()               -- remove old low-value tool results
microcompact()                      -- cached tool result deduplication
applyCollapsesIfNeeded()            -- context collapse projection
autocompact()                       -- full summary-based compaction
```

Each layer can reduce the message set. Autocompact can also yield new boundary summary messages.

---

## 8. Overall Structure and Line Count

### Size Breakdown

| Section | Lines | Description |
|---------|-------|-------------|
| Imports and feature flags | 1-121 | All dependencies, conditional requires |
| Helper generators | 123-149 | `yieldMissingToolResultBlocks` |
| Constants and type guards | 151-179 | Thinking rules, withheld-error check |
| Type definitions | 181-217 | `QueryParams`, `State` |
| `query()` wrapper | 219-239 | Entry point, command lifecycle |
| `queryLoop()` setup | 241-306 | Destructure params, init state, start prefetch |
| Loop body header | 307-360 | Destructure state, setup query tracking |
| Compaction pipeline | 361-548 | Boundary, budget, snip, microcompact, collapse, autocompact |
| API call preparation | 549-648 | Streaming executor, model selection, blocking check |
| API streaming loop | 650-863 | `deps.callModel()`, chunk processing, error withholding |
| Deferred boundary | 864-892 | Microcompact boundary with actual cache_deleted tokens |
| Fallback/error handling | 893-997 | Model fallback, general error handling |
| Post-stream abort check | 998-1052 | Handle aborted streaming, post-sampling hooks |
| No-tool endpoint | 1053-1358 | 413 recovery, max-tokens recovery, stop hooks, token budget, terminal |
| Tool execution | 1359-1408 | Streaming tool executor or `runTools()` |
| Tool summary generation | 1409-1482 | Haiku-generated summaries for mobile |
| Post-tool abort check | 1483-1516 | Handle abort during tool execution |
| Attachments injection | 1517-1663 | Queued commands, memory prefetch, skill discovery |
| MCP tool refresh | 1658-1671 | Refresh tools for newly-connected MCP servers |
| Next-turn transition | 1672-1728 | Turn count, maxTurns check, continue site |

### Architecture Summary

```
query()
  └── queryLoop()
        └── while(true) {
              1. Extract messages after compaction boundary
              2. Run compaction pipeline (snip -> microcompact -> collapse -> autocompact)
              3. Check hard token limits
              4. callModel() -> streaming for-await loop
                 ├── Handle fallbacks
                 ├── Withhold recoverable errors
                 ├── Execute tools during stream (StreamingToolExecutor)
                 └── Yield messages to consumer
              5. Post-stream: check abort, handle errors
              6. If no follow-up needed:
                 ├── Try 413 recovery chain (collapse -> reactive -> surface)
                 ├── Try max-output-tokens recovery (escalate -> continue message)
                 ├── Run stop hooks
                 ├── Check token budget
                 └── Return Terminal
              7. Execute remaining tools (StreamingToolExecutor or runTools)
              8. Inject attachments (queue, memory, skills)
              9. Refresh MCP tools
              10. Check maxTurns
              11. Build next State -> continue
            }
```

### Key Design Principles

1. **AsyncGenerator for push-based streaming**: Consumers see messages as they arrive, not after the turn completes
2. **Immutable state transitions**: Every loop iteration builds a complete new State object
3. **Error recovery as first-class loop paths**: 413 recovery, model fallback, max-tokens escalation are all structured as loop continue sites, not separate error handlers
4. **Feature-flag gating via bundle-time tree-shaking**: `feature()` + conditional `require()` ensures experimental code never ships in external builds
5. **Dependency injection via `QueryDeps`**: The `deps` parameter (defaulting to `productionDeps()`) makes the entire loop testable
6. **Defense in depth for context limits**: Six layers of prevention (snip, microcompact, collapse, autocompact, reactive compact, hard block) before the user ever sees an error
