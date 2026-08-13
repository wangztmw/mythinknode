# Claude Code Supporting Infrastructure -- Comprehensive Analysis

This document analyzes five key source files that form the supporting infrastructure around Claude Code's main LLM query loop. They handle user input processing, permission checking, agent context management, message normalization, and the fork subagent mechanism.

---

## 1. File-by-File Summary and Connection to the Main Loop

### 1.1 queryHelpers.ts

**Purpose:** Utility functions that run between/before turns of the main query loop.

**Key exports and how they connect:**

| Function | Role in the loop |
|---|---|
| `isResultSuccessful()` | Runs after the API returns. Determines if the model produced a meaningful response (text, thinking, or tool_results) vs. an error/empty turn. Has a carve-out for `stop_reason === 'end_turn'` with zero content blocks -- the API legitimately returns nothing when the model decides no output is needed (e.g., after a task_notification drain turn). |
| `normalizeMessage()` | Generator that converts internal `Message` union types into the normalized `SDKMessage` format consumed by the API/SDK layer. Handles assistant, user, progress (agent_progress, skill_progress, bash_progress), and tool_progress message types. For bash_progress, applies a 30-second throttle with LRU eviction on the tracking map (max 100 entries). |
| `handleOrphanedPermission()` | Runs when a permission prompt was detached from the main flow (e.g., on CCR resume). It finds the orphaned tool_use block via `toolUseID`, reconstructs a `canUseTool` callback from the stored `PermissionResult`, injects the assistant message back into `mutableMessages` (with dedup guard), yields the SDK message, and then re-executes the tool via `runTools()`. |
| `extractReadFilesFromMessages()` | Reconstructs a `FileStateCache` from message history by doing a two-pass scan: first pass collects tool_use blocks (Read/Write/Edit), second pass matches tool_result blocks to their tool_use IDs. Handles Read results by stripping line-number prefixes and `<system-reminder>` blocks. For Write, caches the input content directly. For Edit, reads post-edit state from disk via `readFileSyncWithMetadata` using actual mtime. Returns a size-limited cache (default 10 entries for ask operations). |
| `extractBashToolsFromMessages()` | Extracts the set of CLI tool names used in BashTool calls across all messages. Skips env-var assignments and `sudo` prefix. Used for analytics/context. |

**Connection to the main loop:** `handleOrphanedPermission` is called mid-turn when a permission gap is detected. `normalizeMessage` bridges internal message representation to SDK format. `extractReadFilesFromMessages` rebuilds file state for resumption/side-questions.

### 1.2 queryContext.ts

**Purpose:** Builds the API cache-key prefix (systemPrompt + userContext + systemContext) that sits at the front of every `query()` call. Lives in its own file to avoid circular imports (it imports from `context.ts` and `constants/prompts.ts`, which are high in the dependency graph).

**Key exports:**

- **`fetchSystemPromptParts()`** -- Fetches three pieces in parallel via `Promise.all`:
  1. `defaultSystemPrompt` -- the full system prompt parts from `getSystemPrompt()`, or `[]` if `customSystemPrompt` is set (which replaces the default entirely).
  2. `userContext` -- from `getUserContext()` (CLAUDE.md, MEMORY.md, etc.).
  3. `systemContext` -- from `getSystemContext()`, skipped when `customSystemPrompt` is set (would append to a default that isn't used).
  
  These three pieces form the prefix that the API prompt cache keys on.

- **`buildSideQuestionFallbackParams()`** -- Called when the SDK fires a `side_question` mid-turn and there is no `stopHooks` snapshot yet. It reconstructs `CacheSafeParams` by:
  1. Fetching system prompt parts via `fetchSystemPromptParts()`.
  2. Assembling the final system prompt (custom or default + append).
  3. Stripping the in-progress assistant message (stop_reason === null) from messages.
  4. Building a synthetic `ToolUseContext` with no-op callbacks for `setInProgressToolUseIDs`, `setResponseLength`, `updateFileHistoryState`, `updateAttributionState`.
  5. Returning `{ systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages }`.

**Connection to the main loop:** `QueryEngine.ts` and `cli/print.ts` (SDK entrypoint) import from here. The prefix built here determines prompt cache hit/miss -- if it changes between turns, the entire prompt must be re-sent.

### 1.3 processUserInput.ts

**Purpose:** The user input preprocessing pipeline. Converts raw user input (string or ContentBlockParam[]) into structured messages ready for `query()`.

**Pipeline flow:**

```
Raw Input
  |
  v
Image processing (resize, downsample, metadata extraction)
  |
  v
Mode routing:
  |-- bash mode  --> processBashCommand()
  |-- slash cmd  --> processSlashCommand()
  |-- prompt mode --> processTextPrompt()
  |                    |
  |              Ultraplan keyword? --> /ultraplan reroute
  |              Bridge-safe check for remote commands
  |              Attachment extraction (getAttachmentMessages)
  |              Agent mention detection
  v
UserPromptSubmit hooks execution
  |-- blockingError? --> return error, shouldQuery=false
  |-- preventContinuation? --> return stop message, shouldQuery=false
  |-- additionalContexts? --> append attachment messages
  v
Final result: { messages, shouldQuery, allowedTools?, model?, ... }
```

**Key design decisions:**

1. **Pre-expansion input for ultraplan:** Pasted content containing "ultraplan" should NOT trigger the ultraplan reroute. The code tracks `preExpansionInput` separately from the expanded input.

2. **Bridge-safe commands:** Mobile/web clients send `bridgeOrigin=true` with `skipSlashCommands=true`. The code checks `isBridgeSafeCommand()` to selectively allow safe commands (like `/model`) while blocking unsafe ones (like `/config`).

3. **Lazy imports:** `processSlashCommand`, `processBashCommand` are dynamically imported to avoid loading the full command tree for every input.

4. **Image metadata injection:** After processing, if images were present, an `isMeta: true` user message with image metadata (dimensions, source paths) is appended so the model knows about images without them being displayed to the user.

**Connection to the main loop:** This is the preprocessing step before `query()` is called. It produces the messages that will be appended to the conversation and the `shouldQuery` flag that determines whether to call the API at all.

### 1.4 agentContext.ts

**Purpose:** Tracks agent identity across async operations using Node.js `AsyncLocalStorage`. This allows concurrent agents running in the same process to have isolated identity contexts.

**Architecture:**

Two agent types form a discriminated union:

```
AgentContext = SubagentContext | TeammateAgentContext
```

| Field | SubagentContext | TeammateAgentContext |
|---|---|---|
| `agentType` | `'subagent'` | `'teammate'` |
| `agentId` | UUID | `"name@team"` |
| `parentSessionId` | optional (main REPL) | required (team lead's ID) |
| `subagentName` | type name | N/A |
| `isBuiltIn` | boolean | N/A |
| `teamName` | N/A | string |
| `agentColor` | N/A | optional |
| `planModeRequired` | N/A | boolean |
| `isTeamLead` | N/A | boolean |
| `invokingRequestId` | optional | optional |
| `invocationKind` | `'spawn'` or `'resume'` | `'spawn'` or `'resume'` |
| `invocationEmitted` | mutable boolean | mutable boolean |

**Why AsyncLocalStorage instead of AppState:**
When agents are backgrounded (ctrl+b), multiple agents can run concurrently in the same process. `AppState` is a single shared state that would be overwritten. `AsyncLocalStorage` isolates each async execution chain.

**Key functions:**

- `getAgentContext()` -- Returns current context or undefined (main thread).
- `runWithAgentContext(ctx, fn)` -- Wraps an async function in an agent context.
- `isSubagentContext()` / `isTeammateAgentContext()` -- Type guards.
- `getSubagentLogName()` -- Returns `subagentName` for built-in agents, `"user-defined"` for custom agents.
- `consumeInvokingRequestId()` -- **One-shot edge emission pattern:** Returns the invoking request ID on the first call after a spawn/resume, then flips `invocationEmitted=true` so subsequent calls return undefined. Used for telemetry edges between parent and child agents.

**Connection to the main loop:** Every subagent and teammate runs inside `runWithAgentContext()`. The context flows through all async operations, allowing analytics, logging, and permission systems to attribute events to the correct agent.

### 1.5 forkSubagent.ts

**Purpose:** Implements the "fork" mechanism -- a lightweight subagent that inherits the parent's full conversation context and system prompt, maximizing prompt cache reuse.

**Feature gate:**
```typescript
isForkSubagentEnabled(): boolean
```
Enabled when `FORK_SUBAGENT` experiment flag is on AND:
- NOT in coordinator mode (mutually exclusive -- coordinator has its own delegation).
- NOT in non-interactive/print mode.

**How fork differs from regular agents:**

| Aspect | Regular Agent | Fork Agent |
|---|---|---|
| Context | Fresh conversation, directive only | Full parent history inherited |
| System prompt | Built from agent definition | Parent's exact rendered bytes (for cache hits) |
| Tool pool | Agent-defined subset | Parent's exact tool pool (`tools: ['*'] + useExactTools`) |
| Tool results | Real results from execution | Placeholder text: `"Fork started -- processing in background"` |
| Permission mode | Agent-defined | `'bubble'` (surfaces to parent terminal) |
| Model | Agent-defined | `'inherit'` (same as parent) |
| Recursion guard | N/A | Checks for `<fork-boilerplate>` tag in history |

**Prompt cache optimization strategy:**

The critical insight is that for N fork children to share the same prompt cache prefix, their API requests must be byte-identical up to the divergent point. `buildForkedMessages()` achieves this by:

1. Keeping the full parent assistant message (all tool_use blocks, thinking, text) -- identical for all children.
2. Building a single user message containing:
   - Tool_result blocks for EVERY tool_use, each with the identical placeholder `"Fork started -- processing in background"`.
   - A final text block with the per-child directive (THE ONLY differing byte sequence).

Result structure:
```
[...history, assistant(all_tool_uses), user(placeholder_results..., directive_text)]
                                          ^-- cached prefix --^  ^-- differs here
```

**Worktree isolation:** When `isolation: "worktree"` is used, `buildWorktreeNotice()` injects a notice telling the child to translate paths from the inherited context and that its changes are isolated.

**Connection to the main loop:** When the parent model emits an Agent tool_use without `subagent_type` and the fork experiment is active, `forkSubagent.ts` builds the forked conversation and spawns it. The parent continues immediately (all forks run in background), and results arrive via `<task-notification>` messages.

---

## 2. Permission Checking (canUseTool Pattern)

The permission system centers on the `CanUseToolFn` type:

```typescript
type CanUseToolFn<Input> = (
  tool: Tool,
  input: Input,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  forceDecision?: PermissionDecision<Input>
) => Promise<PermissionDecision<Input>>
```

**How it flows:**

1. **`hasPermissionsToUseTool()`** is called first. It checks permission rules (allow/deny lists, mode-based rules, classifier decisions) and returns a `PermissionResult` with behavior `'allow'` or `'deny'`.

2. If allowed, a `PermissionDecision` is built with `decisionReason`.

3. If denied or needs interactive confirmation, the UI layer (`useCanUseTool` hook in React/Ink) handles the prompt queue:
   ```
   hasPermissionsToUseTool() --> allow? --> buildAllow()
                            --> deny?  --> handleInteractivePermission() / handleCoordinatorPermission() / handleSwarmWorkerPermission()
   ```

4. In **orphaned permission** recovery (`handleOrphanedPermission` in queryHelpers.ts), a synthetic `canUseTool` is constructed:
   ```typescript
   const canUseTool: CanUseToolFn = async () => ({
       ...permissionResult,
       decisionReason: { type: 'mode', mode: 'default' },
   })
   ```
   This reuses the stored decision without re-prompting.

5. The `canUseTool` callback is threaded through `runTools()` which calls it before executing each tool.

**Permission modes** visible in the codebase: `'default'`, `'bubble'` (fork subagents surface to parent), and mode-based routing in `useCanUseTool.tsx` via `handleCoordinatorPermission`, `handleInteractivePermission`, `handleSwarmWorkerPermission`.

---

## 3. How processUserInput Prepares Context for query()

The pipeline produces a `ProcessUserInputBaseResult`:

```typescript
{
  messages: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage | ProgressMessage)[],
  shouldQuery: boolean,         // false = don't call API (command handled locally)
  allowedTools?: string[],       // restrict tool set for this turn
  model?: string,                // override model for this turn
  effort?: EffortValue,          // reasoning effort
  resultText?: string,           // output for -p mode
  nextInput?: string,            // chain to next input (e.g., /discover -> feature)
  submitNextInput?: boolean,
}
```

**Context assembly before query():**

1. The `options` object in `ToolUseContext` carries the full tool definitions, MCP clients, model, thinking config, commands, and agent definitions.

2. `getAppState()` provides `toolPermissionContext` (mode, additionalWorkingDirectories) and other UI state.

3. `readFileState` (the `FileStateCache`) tracks what files the model has read, enabling:
   - Deduplication (don't re-inject already-read files).
   - Change detection between turns (`getChangedFiles`).
   - Permission decisions (has the model read this file before?).

4. Attachment extraction (`getAttachmentMessages`) scans the input for `@file`, `@folder`, `@agent-name`, and image pastes, converting them to structured attachment messages.

5. UserPromptSubmit hooks can inject `additionalContexts`, block execution (`blockingError`), or stop continuation (`preventContinuation`), all before `query()` is called.

**The result merges with the main conversation in the caller** (QueryEngine or print.ts): the produced messages are appended to `mutableMessages`, and if `shouldQuery` is true, the full message array is sent to the model.

---

## 4. Agent Context / Task Management Across Sub-agents

**Identity tracking across process boundaries:**

For in-process subagents and teammates, `AsyncLocalStorage` provides isolation. For separate processes (tmux/iTerm2 swarm workers), environment variables serve the same purpose:
- `CLAUDE_CODE_AGENT_ID`
- `CLAUDE_CODE_PARENT_SESSION_ID`

**Parent-child telemetry edges:**

The `invokingRequestId` + `invocationKind` + `invocationEmitted` triple enables tracing which parent API call spawned or resumed a child agent:

```
Parent's API call (request_id: "req_abc")
  |
  |-- subagent spawn (invokingRequestId: "req_abc", invocationKind: "spawn")
  |     |
  |     |-- consumeInvokingRequestId() --> returns "req_abc", flips emitted=true
  |     |     (attached to tengu_api_success/error event)
  |     |
  |     |-- consumeInvokingRequestId() --> undefined (already emitted)
  |
  |-- SendMessage resume (invokingRequestId: "req_def", invocationKind: "resume")
        |
        |-- consumeInvokingRequestId() --> returns "req_def", flips emitted=true
```

`invocationEmitted` is a **mutable flag on the context object** -- reset to false on each spawn/resume boundary. This is safe because AsyncLocalStorage provides per-chain isolation.

**Agent definitions:**

The `agentDefinitions` in `ToolUseContext.options` carries `{ activeAgents, allAgents }`. `activeAgents` contains the agent types available for the current turn; `allAgents` carries the full registry.

---

## 5. How Fork Subagent Differs from Regular Agents

### Regular Agent Spawn

1. User/types model emits: `Agent({ subagent_type: "Explore", description: "find X" })`
2. The Agent tool looks up the agent definition (`builtInAgents` or `userAgents`).
3. Builds a fresh system prompt from `definition.getSystemPrompt()`.
4. Creates a new conversation: `[system_prompt, user_message("Your task: find X")]`.
5. Runs the agent loop with the agent's specific tool subset.
6. When done, returns results as a tool_result to the parent.

### Fork Agent Spawn

1. Model emits: `Agent({ description: "refactor the auth module" })` -- no `subagent_type`.
2. Feature gate check: `isForkSubagentEnabled()` passes.
3. Recursion guard: `isInForkChild(messages)` checks for `<fork-boilerplate>` tag.
4. `buildForkedMessages()` constructs the child conversation:
   - Full parent assistant message (all tool_uses intact).
   - Single user message with placeholder tool_results + fork boilerplate + directive.
5. Passes `override.systemPrompt` with the parent's exact rendered system prompt bytes.
6. Passes `useExactTools: true` so the child gets the parent's tool pool.
7. Child runs in background; parent continues immediately.
8. Child result arrives via `<task-notification>` in a subsequent turn.

### Key Design Differences

| | Regular Agent | Fork Agent |
|---|---|---|
| **Context** | Fresh, minimal | Full parent history |
| **Cache strategy** | Independent cache prefix | Shared prefix with parent + siblings |
| **Tool results** | Real execution results | Placeholder ("processing in background") |
| **Blocking** | Parent waits (sync) | Parent continues (async/background) |
| **Recursion** | Doesn't apply | Explicit guard via boilerplate tag |
| **Worktree** | Not applicable | Supported with path translation notice |
| **System prompt** | Built fresh from definition | Threaded bytes from parent (byte-exact for cache) |

---

## 6. Shared State Patterns

### 6.1 AsyncLocalStorage (Thread-Local State)

The cleanest pattern in the codebase. agentContext.ts uses `AsyncLocalStorage<AgentContext>` to propagate agent identity through the entire async call tree without parameter drilling. This is similar to React Context or Go's `context.Context`.

### 6.2 FileStateCache (LRU with Path Normalization)

A wrapper around `lru-cache` that normalizes all path keys via `path.normalize()` before access. This ensures `/foo/bar`, `foo/bar`, and `/foo/baz/../bar` hit the same cache entry. Used for:
- Tracking what files the model has read (dedup injection).
- Change detection between turns (`getChangedFiles` compares timestamps).
- Permission decisions (has model read this file?).

### 6.3 Mutable Message Arrays

Messages flow through the system as mutable arrays (`Message[]`). Both `handleOrphanedPermission` and the main query loop push to `mutableMessages` and call `recordTranscript()` for persistence. The two-pass pattern in `extractReadFilesFromMessages` (pass 1: find tool_uses, pass 2: match tool_results) works on this array.

### 6.4 getAppState/setAppState Function Pair

Instead of passing `AppState` directly, functions `() => AppState` and `(f: (prev) => AppState) => void` are threaded through `ToolUseContext`. This is a functional lens pattern -- callers always read latest state and update atomically via the updater function.

### 6.5 ProcessUserInputContext = ToolUseContext & LocalJSXCommandContext

A TypeScript intersection type that combines tool execution context with local JSX command context, providing the full environment for user input processing.

### 6.6 CacheSafeParams

A snapshot bundle of `{ systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages }` that can be used to reconstruct the API cache prefix. Used by fork agents and side questions.

---

## 7. Clever Algorithms and Data Structures

### 7.1 Prompt Cache Prefix Sharing (forkSubagent.ts)

The fork message builder maximizes Anthropic prompt cache hits by making all fork children share a byte-identical prefix. The key insight: only the final text block in the constructed user message differs between children. Everything before that (history + assistant message + identical placeholder tool_results) is shared cache. This is a manual implementation of what amounts to prefix-sharing in a trie-like structure.

### 7.2 Two-Pass File State Reconstruction (queryHelpers.ts)

`extractReadFilesFromMessages()` scans message history in two passes:
- **Pass 1:** Collect tool_use IDs and their target file paths.
- **Pass 2:** Match tool_result blocks to find the actual content.

This handles the disconnect between when a tool is requested (assistant message) and when its result arrives (user message with tool_result). For Write operations, the content is taken from the input (not the result, which just says "success"). For Edit operations, the post-edit state is read from disk with actual mtime.

### 7.3 One-Shot Edge Emission (agentContext.ts)

`consumeInvokingRequestId()` implements a one-shot pattern: first call returns the value and flips a flag; subsequent calls return undefined. This ensures each spawn/resume edge is reported to telemetry exactly once, even if multiple code paths try to consume it.

### 7.4 Throttled Progress with LRU Eviction (queryHelpers.ts)

Bash tool progress messages are throttled to one per 30 seconds per tool use ID. The tracking map is capped at 100 entries with LRU eviction (delete first Map key when full). Map iteration order in JavaScript is insertion order, so deleting `keys().next().value` achieves LRU semantics without a full cache library.

### 7.5 Parallel Promise.all for Cache Prefix Parts (queryContext.ts)

System prompt, user context, and system context are fetched in parallel via `Promise.all([])` since they are independent. When `customSystemPrompt` is set, the corresponding promises resolve immediately with `[]`/`{}`, keeping the parallel structure intact.

### 7.6 Normalized Path LRU Cache (fileStateCache.ts)

The `FileStateCache` wraps every get/set/has/delete with `path.normalize()`, ensuring path format inconsistencies don't cause cache misses. Uses `Buffer.byteLength()` as the size calculator for the LRU cache (capped at 25MB).

### 7.7 Recursive Fork Prevention via Content Inspection (forkSubagent.ts)

`isInForkChild()` scans all user messages for the `<fork-boilerplate>` XML tag. This is a content-based recursion guard rather than a flag or counter -- it works across serialization boundaries (transcript save/restore) without additional state.

---

## 8. Overall Architecture Diagram

```
                         +------------------+
                         |   User Input     |
                         | (string/blocks)  |
                         +--------+---------+
                                  |
                                  v
                    +-------------+-------------+
                    |   processUserInput.ts     |
                    |                            |
                    |  image resize -> mode route |
                    |  /cmd? -> processSlashCmd  |
                    |  bash? -> processBashCmd   |
                    |  text? -> processTextPrompt |
                    |                            |
                    |  UserPromptSubmit hooks    |
                    +-------------+-------------+
                                  |
                     { messages, shouldQuery }
                                  |
                                  v
               +------------------+------------------+
               |          queryContext.ts             |
               |                                     |
               |  fetchSystemPromptParts()            |
               |    - getSystemPrompt()               |
               |    - getUserContext() (CLAUDE.md...) |
               |    - getSystemContext()              |
               |                                     |
               |  buildSideQuestionFallbackParams()   |
               +------------------+------------------+
                                  |
                     CacheSafeParams
                                  |
                                  v
            +---------------------+---------------------+
            |              QueryEngine.ts                |
            |                                           |
            |  Assembles: [systemPrompt, messages]       |
            |  Calls Anthropic API                       |
            |  Receives: assistant message               |
            +---------------------+---------------------+
                        |                   |
              has tool_use?           text response?
                        |                   |
                        v                   v
            +-----------+-----------+   display
            |   Permission Check    |   to user
            |                       |
            | hasPermissionsToUse   |
            | Tool() --> allow?     |
            |        --> deny?      |
            |        --> prompt UI  |
            +-----------+-----------+
                        |
            canUseTool callback
                        |
                        v
            +-----------+-----------+
            |     runTools()        |
            |  (toolOrchestration)  |
            +-----------+-----------+
                        |
               +--------+---------+
               |                  |
         Regular Tool       Agent Tool
               |                  |
               v                  v
    +----------+----------+  +---+-------------------+
    | Bash/Read/Write/... |  |  subagent_type given?  |
    +---------------------+  +-----------+-----------+
                                |         |
                               YES        NO (or fork enabled)
                                |         |
                                v         v
                    +-----------+--+  +---+------------------+
                    | Regular Agent |  |  forkSubagent.ts     |
                    |               |  |                      |
                    | Fresh context |  | Inherits full parent |
                    | Own sysprompt |  | context + sysprompt  |
                    | Tool subset   |  | Placeholder results  |
                    | Sync exec     |  | Background exec      |
                    +---------------+  | Cache-optim prefix   |
                                       +----------------------+

                    +=====================================+
                    |     Cross-Cutting Infrastructure     |
                    +=====================================+
                    |                                       |
                    |  agentContext.ts (AsyncLocalStorage)  |
                    |  - Isolates concurrent agent identity |
                    |  - consumeInvokingRequestId() edges   |
                    |                                       |
                    |  queryHelpers.ts                      |
                    |  - normalizeMessage() SDK bridge      |
                    |  - handleOrphanedPermission()         |
                    |  - extractReadFilesFromMessages()     |
                    |  - isResultSuccessful() turn check    |
                    |                                       |
                    |  fileStateCache.ts                    |
                    |  - Normalized-path LRU cache          |
                    |  - Tracks read/modified files         |
                    |                                       |
                    |  useCanUseTool.tsx                    |
                    |  - Permission prompt queue            |
                    |  - Mode routing (interactive/         |
                    |    coordinator/swarm)                 |
                    +=======================================+
```

### Key Data Flow Summary

1. **Input to messages:** `processUserInput` transforms raw input into structured messages.
2. **Messages to context:** `queryContext.fetchSystemPromptParts` builds the cache prefix.
3. **Context + messages to API:** QueryEngine sends the assembled request.
4. **API response to tools:** Assistant tool_use blocks are checked via `canUseTool`, then executed via `runTools`.
5. **Tool results to messages:** Results are appended to `mutableMessages` and persisted via `recordTranscript`.
6. **Agent spawns:** Either regular (fresh context) or fork (inherited context with cache optimization).
7. **Agent identity:** Flows through everything via `AsyncLocalStorage`, enabling correct attribution even with concurrent background agents.
