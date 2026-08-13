# QueryEngine Analysis

**File**: `/src/QueryEngine.ts` (1296 lines)
**Role**: Outer shell of Claude Code's agent loop -- owns the query lifecycle and session state for a headless/SDK conversation.

---

## 1. Class Structure and Ownership

`QueryEngine` (line 184) is the sole class in this file. One instance per conversation.

**Private fields** (lines 185-198):

| Field | Type | Purpose |
|-------|------|---------|
| `config` | `QueryEngineConfig` | Immutable configuration (tools, commands, MCP clients, agents, models, budget, etc.) |
| `mutableMessages` | `Message[]` | The growing conversation transcript -- all user, assistant, progress, attachment, and system messages across all turns |
| `abortController` | `AbortController` | Cancellation signal shared with the inner query() loop |
| `permissionDenials` | `SDKPermissionDenial[]` | Accumulated list of every denied tool use request |
| `totalUsage` | `NonNullableUsage` | Cumulative token usage across all API calls in the session |
| `hasHandledOrphanedPermission` | `boolean` | Once-per-engine-lifetime guard for orphaned permission replay |
| `readFileState` | `FileStateCache` | File content cache shared with tool execution context |
| `discoveredSkillNames` | `Set<string>` | Turn-scoped tracking of slash-command skills discovered during user input processing |
| `loadedNestedMemoryPaths` | `Set<string>` | Tracks which nested MEMORY.md files have been loaded, persists across turns |

**Public methods**:
- `submitMessage()` -- async generator, the main entry point
- `interrupt()` -- aborts the current turn
- `getMessages()` -- returns the message history
- `getReadFileState()` -- returns the file cache
- `getSessionId()` -- returns the session UUID
- `setModel()` -- updates the model mid-session

**Convenience wrapper**: `ask()` (line 1186) is a standalone async generator that creates a `QueryEngine`, calls `submitMessage()`, and extracts `readFileState` in a `finally` block.

---

## 2. submitMessage() Lifecycle

`submitMessage()` (lines 209-1156) is an `AsyncGenerator<SDKMessage>`. It takes a prompt (`string | ContentBlockParam[]`) and optional `{ uuid, isMeta }` options.

### Phase 1: Setup (lines 237-407)

1. **Clear per-turn state**: `discoveredSkillNames.clear()`, `setCwd(cwd)` (line 238-239)
2. **Wrap `canUseTool`**: intercepts permission decisions, records denials in `this.permissionDenials` (lines 244-271)
3. **Resolve model and thinking config** (lines 273-282): uses user-specified model, falls back to main loop model. Thinking defaults to `adaptive` unless explicitly disabled.
4. **Fetch system prompt parts** via `fetchSystemPromptParts()` (lines 288-301): assembles tools, MCP clients, working directories, custom prompts
5. **Build final `systemPrompt`** (lines 321-325): concats custom prompt, optional memory-mechanics prompt (when `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` is set), and append prompt
6. **Register structured output hook** (lines 328-333): if `jsonSchema` is provided and `SyntheticOutputTool` is in the tool list
7. **Construct `processUserInputContext`** (lines 335-395): a large context object bridging QueryEngine to the `processUserInput()` function. Includes message mutation callbacks, file history/attribution updaters, skill discovery tracking, MCP/plugin/IDE state.

### Phase 2: Orphaned Permission (lines 398-408)

Only once per engine lifetime. Replays a permission decision from a previous session that was interrupted before tool execution could complete.

### Phase 3: Process User Input (lines 410-428)

Calls `processUserInput()` which:
- Resolves slash commands
- Handles attachments, mentions, images
- Processes permission rules
- Returns `{ messages, shouldQuery, allowedTools, model, resultText }`

If `shouldQuery` is `false` (local slash command that doesn't need AI), the function yields `SDKUserMessageReplay` messages for command stdout/stderr and returns immediately with a `result/success` message (lines 556-639). No API call is made.

### Phase 4: Persist User Messages (lines 436-463)

Writes the user's messages to the transcript (via `recordTranscript`) **before** entering the query loop. This is load-bearing: if the process is killed before the API responds, `--resume` can still find the conversation. In `--bare` mode, this write is fire-and-forget (line 453) for latency reasons.

### Phase 5: File History Snapshot (lines 641-655)

If file history is enabled, takes a snapshot of the file system state for each replayable user message. Allows undo/restore of file changes later.

### Phase 6: Enter the query() Loop (lines 675-1049)

This is the core agent loop. See section 3 for details.

### Phase 7: Result Assembly (lines 1050-1155)

After the loop exits (all turns complete, or an error/limit was hit), the function:
1. Finds the last user or assistant message in the result set (line 1058)
2. Checks `isResultSuccessful()` -- if false, yields `error_during_execution` with scoped diagnostic errors (lines 1082-1118)
3. Extracts text result from the last assistant content block (lines 1124-1133)
4. Yields a `result/success` message with aggregated usage, cost, permission denials, stop reason, and structured output (lines 1135-1155)

---

## 3. Outer Shell vs Inner query() Loop

The `for await (const message of query({...}))` at line 675 is the bridge between the outer shell (QueryEngine) and the inner agent loop (query.ts).

### What query() receives:
- `messages` -- a **copy** of `mutableMessages` (line 434: `const messages = [...this.mutableMessages]`)
- `systemPrompt`, `userContext`, `systemContext` -- assembled system prompt and context
- `wrappedCanUseTool` -- the permission-intercepted version
- `toolUseContext` -- the rebuilt `processUserInputContext`
- `fallbackModel`, `querySource`, `maxTurns`, `taskBudget`

### What QueryEngine does with each yielded message:

The switch statement at line 757 handles 10 message types:

| Type | Action |
|------|--------|
| `tombstone` | Control signal, skipped (line 759) |
| `assistant` | Captures stop_reason, pushes to `mutableMessages`, yields via `normalizeMessage()` (lines 761-770) |
| `progress` | Pushes to `mutableMessages` and the local copy `messages`, records transcript inline, yields via `normalizeMessage()` (lines 771-783) |
| `user` | Pushes to `mutableMessages`, yields via `normalizeMessage()` (lines 784-787) |
| `stream_event` | Tracks `message_start`/`message_delta`/`message_stop` for usage accumulation and stop_reason capture. Optionally yields raw stream events if `includePartialMessages` is true (lines 788-828) |
| `attachment` | Pushes to `mutableMessages`. Handles: `structured_output` (captures for result), `max_turns_reached` (yields error and returns), `queued_command` (yields as SDK user message replay) (lines 829-893) |
| `stream_request_start` | Skipped (line 896) |
| `system` | First checks snip replay (lines 904-915) for HISTORY_SNIP feature. Then handles: `compact_boundary` (splices mutableMessages/messages to GC pre-compaction messages, yields boundary to SDK), `api_error` (yields retry info). Other system messages are suppressed in headless mode (lines 897-957) |
| `tool_use_summary` | Yielded directly to SDK (lines 960-968) |

### In-loop checks (after each message):

1. **Budget exceeded** (lines 972-1002): if `getTotalCost() >= maxBudgetUsd`, yields `error_max_budget_usd` and returns
2. **Structured output retry limit** (lines 1005-1048): on each user message, counts `SyntheticOutputTool` calls this query, returns `error_max_structured_output_retries` if >= `MAX_STRUCTURED_OUTPUT_RETRIES` (default 5)

### Key design: dual message arrays

There are TWO message arrays:
- `this.mutableMessages` -- the persistent store, survives across turns
- `messages` (local copy) -- passed to query(), grows to include assistant/progress/attachment messages in the "pass to next API call" set

The transcript recording (line 717+) writes the `messages` array to disk. For assistant messages, this is fire-and-forget (line 728: `void recordTranscript(messages)`) to avoid blocking the generator while waiting for `message_delta` to fill in `usage`/`stop_reason`.

---

## 4. Mechanism Catalog

### Permission Tracking (lines 244-271)

`wrappedCanUseTool` wraps the config's `canUseTool` function. Every denial (behavior !== 'allow') is recorded:
```typescript
this.permissionDenials.push({
  tool_name: sdkCompatToolName(tool.name),
  tool_use_id: toolUseID,
  tool_input: input,
})
```

`sdkCompatToolName` (systemInit.ts:23-25) translates `Agent` back to `Task` for backward compatibility with older SDK consumers. Denials are reported in every result message's `permission_denials` field.

### Transcript Recording (lines 436-463, 701-732)

`recordTranscript(messages)` writes to a JSONL session file. Key behaviors:
- User messages are written **before** entering the query loop (so `--resume` works even if killed before API responds)
- In `--bare` mode: fire-and-forget (line 453)
- In non-bare mode: awaited (line 455)
- `CLAUDE_CODE_EAGER_FLUSH` or `CLAUDE_CODE_IS_COWORK` triggers `flushSessionStorage()` (line 460)
- Inside the query loop: assistant messages fire-and-forget (line 728), user/system messages awaited (line 730)
- Before compact boundaries: flushes messages up through `preservedSegment.tailUuid` (lines 702-715)
- Before result yields: flush if eager/cowork (lines 1073-1080)

### File History Snapshots (lines 641-655)

After determining the query should proceed, `fileHistoryMakeSnapshot()` is called for each replayable user message. The snapshot captures the current file system state so the user can later undo changes made during the conversation.

### Tool Use Counting (line 672-673)

```typescript
const initialStructuredOutputCalls = jsonSchema
  ? countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
  : 0
```

Delta-based counting: compares current count vs initial to determine how many retries have happened this query, without tracking a separate counter.

### Structured Output

When `jsonSchema` is provided (lines 328-333, 838-840, 1004-1048):
1. A function hook is registered to enforce JSON output formatting
2. `SyntheticOutputTool` call results (attachment type `structured_output`) are captured
3. Retries are limited (default 5, configurable via `MAX_STRUCTURED_OUTPUT_RETRIES`)

### Session Management

- Session ID from `getSessionId()` (bootstrap/state.ts)
- Session persistence via `isSessionPersistenceDisabled()`
- `interrupt()` method (line 1158) calls `abortController.abort()` -- propagates through to query() and the API client

---

## 5. Message Consumption from query()

Each message from query() goes through:

### Transcript recording (lines 688-732)

Messages of type `assistant`, `user`, or `system/compact_boundary` are pushed into the local `messages` array and conditionally recorded. Assistant messages are fire-and-forget because `claude.ts` yields one message per content block, then mutates the last one's `usage`/`stop_reason` on `message_delta`. Awaiting would block the generator, preventing `message_delta` from running.

### Acknowledgment replay (lines 735-750)

After the first transcript recording, `messagesToAck` (filtered user messages and compact boundaries) are yielded as `SDKUserMessageReplay` events. This allows SDK consumers that track message order to see the acknowledged messages before subsequent assistant output.

### normalizeMessage() processing (in queryHelpers.ts:102-222)

Each message type is mapped to one or more SDK messages:

- **assistant**: split into single-content-block messages via `normalizeMessages()`, empty messages skipped, yielded as `SDKAssistantMessage`
- **progress**: for `agent_progress`/`skill_progress`, the embedded message is normalized and yielded with `parent_tool_use_id`. For `bash_progress`, throttled to one per 30 seconds
- **user**: normalized and yielded with `tool_use_result`, `isSynthetic`, and `mcpMeta` if present

### Stream event handling (lines 788-828)

Three stream events are handled:
- `message_start`: resets `currentMessageUsage`, pulls initial usage from the message
- `message_delta`: updates `currentMessageUsage` and captures `stop_reason` from the delta (the assistant message at `content_block_stop` has `stop_reason=null`; the real value only arrives in `message_delta`)
- `message_stop`: accumulates `currentMessageUsage` into `this.totalUsage`

Optionally, all stream events are yielded to the SDK if `includePartialMessages` is true.

---

## 6. SDK Messages vs Internal Messages

Internal messages (`Message` type, from `src/types/message.ts`) are a rich union type with 10+ variants: `assistant`, `user`, `progress`, `attachment`, `system` (with subtypes like `compact_boundary`, `api_error`, `local_command`, `api_metrics`, etc.), `stream_event`, `stream_request_start`, `tombstone`, `tool_use_summary`.

SDK messages (`SDKMessage`, exported from `agentSdkTypes.ts`) are a simplified public type with fewer variants: `system/init`, `assistant`, `user`, `stream_event`, `tool_progress`, `tool_use_summary`, `system/compact_boundary`, `system/api_retry`, `result/success`, `result/error_*`.

**Key transformations in `normalizeMessage()`** (queryHelpers.ts):
- Multi-content-block assistant messages are split into single-block normalized messages
- Progress messages from agents/skills are unwrapped to expose the inner assistant/user message
- Bash progress is throttled to 30-second intervals
- Internal fields like `isMeta`, `isVisibleInTranscriptOnly`, `mcpMeta` are surfaced as SDK fields (`isSynthetic`, `tool_use_result`)

**Messages NOT forwarded to SDK**:
- `tombstone` messages (skipped entirely)
- `stream_request_start` messages (skipped)
- Most `system` subtype messages in headless mode (only `compact_boundary` and `api_error` are yielded)

---

## 7. State Maintained Across Turns

| State | Scope | Notes |
|-------|-------|-------|
| `mutableMessages` | Session | Full message history, grows unbounded (GC'd at compact boundaries via splice) |
| `totalUsage` | Session | Accumulated token usage (input + output + cache tokens) |
| `permissionDenials` | Session | All denied tool uses, never cleared |
| `readFileState` | Session | File content cache shared with tools |
| `abortController` | Session | Can be aborted externally via `interrupt()` |
| `hasHandledOrphanedPermission` | Session | Boolean guard, set once |
| `loadedNestedMemoryPaths` | Session | Tracks loaded MEMORY.md files |
| `discoveredSkillNames` | **Turn** | Cleared at start of each `submitMessage()` |
| `currentMessageUsage` | **Turn** | Reset on each `message_start`, accumulated into `totalUsage` on `message_stop` |
| `turnCount` | **Turn** | Reset to 1, incremented on each user message |
| `lastStopReason` | **Turn** | Captured from `message_delta` |
| `structuredOutputFromTool` | **Turn** | Captured from attachment, reported in result |

---

## 8. Clever Patterns and Notable Design Decisions

### 8.1 Dual message arrays (lines 434, 676)
`messages = [...this.mutableMessages]` creates a local copy for query() while `this.mutableMessages` remains the source of truth. This lets QueryEngine control what the inner loop sees without being coupled to how query.ts mutates its input.

### 8.2 Fire-and-forget transcript for assistant messages (line 728)
```typescript
if (message.type === 'assistant') {
  void recordTranscript(messages)
}
```
The comment at lines 719-726 explains: `claude.ts` yields one assistant message per content block, then mutates the last one's `usage`/`stop_reason` on `message_delta`. Awaiting would block the generator, preventing `message_delta` from running until every block is consumed.

### 8.3 Pre-loop transcript persistence for resumability (lines 436-463)
User messages are written to transcript **before** entering the query loop. If the process is killed before the API responds, `--resume` can still recover the conversation. This is the single largest controllable critical-path cost (~4ms on SSD).

### 8.4 Compact boundary GC (lines 916-933)
When a `compact_boundary` system message arrives, `mutableMessages` and the local `messages` array are spliced to drop everything before the boundary. This prevents unbounded memory growth in long SDK sessions.

### 8.5 Error watermark for turn-scoped diagnostics (lines 665-669)
```typescript
const errorLogWatermark = getInMemoryErrors().at(-1)
```
Rather than using a length-based index (which breaks when the 100-entry ring buffer shifts), QueryEngine captures the last error object as a reference. Later, `lastIndexOf(errorLogWatermark)` finds the real boundary, or falls back to including everything if the reference was rotated out.

### 8.6 Structured output delta counting (lines 671-673)
Instead of maintaining a separate retry counter, QueryEngine counts existing `SyntheticOutputTool` calls in the message history at query start, then compares the current count after each user message. This is stateless and immune to message order changes.

### 8.7 Dead code elimination via feature() (lines 111-128)
Conditional imports for `COORDINATOR_MODE` and `HISTORY_SNIP` use `bun:bundle`'s `feature()` gate. When the feature flag is off, the entire module is tree-shaken. The imports are wrapped in dynamic `require()` inside conditionals.

### 8.8 Snip replay callback injection (lines 168-172, 904-915)
The `snipReplay` config callback isolates all HISTORY_SNIP specific code from QueryEngine. The callback receives the yielded system message and the mutable messages store, and can replace the entire store if compaction is needed. This keeps feature-gated strings out of QueryEngine (for the excluded-strings check).

### 8.9 processUserInputContext rebuild (lines 335-395 vs 492-527)
The context is built twice: once before `processUserInput()` (with mutable setMessages for slash commands), and once after (with no-op setMessages). This allows slash commands that mutate the message array (like `/force-snip`) to write back to `mutableMessages`, while preventing accidental writes during the query loop.

### 8.10 PermissionMode cast workaround (line 545)
```typescript
mode as PermissionMode // TODO: avoid the cast
```
The permission mode from `AppState.toolPermissionContext.mode` doesn't exactly match the `PermissionMode` type. Acknowledged with a TODO comment.

---

## 9. Architecture Summary

**Total**: 1296 lines. The file contains two exports:
- `QueryEngine` class (lines 184-1177, ~994 lines)
- `ask()` function (lines 1186-1295, ~110 lines)

**Dependency count**: ~50 imports from ~40 different modules.

**Key dependencies**:
- `src/query.ts` -- the inner agent loop (core reasoning + tool execution)
- `src/utils/processUserInput/processUserInput.js` -- slash command resolution, input preprocessing
- `src/utils/queryHelpers.ts` -- message normalization, orphaned permission handling, result validation
- `src/utils/messages.js` -- message creation, normalization, merging, API-bound preprocessing
- `src/utils/messages/systemInit.js` -- `buildSystemInitMessage()` for the SDK init handshake
- `src/utils/sessionStorage.js` -- `recordTranscript()`, `flushSessionStorage()`
- `src/utils/fileHistory.js` -- file system snapshot tracking
- `src/services/api/claude.js` -- usage accumulation utilities
- `src/cost-tracker.js` -- `getTotalCost()`, `getTotalAPIDuration()`
- `src/entrypoints/agentSdkTypes.js` -- public SDK message type definitions

**Architectural role**: QueryEngine is the **adapter** between the internal agent system (query.ts + tools + MCP) and the external SDK/headless interface. It translates internal message types to SDK message types, manages session lifecycle, tracks costs and usage, enforces budget and turn limits, and handles resumability. The REPL path uses `query()` directly without QueryEngine; QueryEngine is specifically for headless, SDK, and spawn-bridge usage.
