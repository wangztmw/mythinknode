# Claude Code 完整运行链路 — 逐层拆解

> **日期**：2026-08-05
> **调研方式**：5 路 Agent 并行读取源码，覆盖入口、查询循环、服务层、工具系统、权限系统
> **源码位置**：`study/claude-code/claude-code-main/src/`
> **前置阅读**：[[agent-cluster-research.md]]（子 Agent 集群调研）、[[findings.md]]（执行机制概述）

---

## 全景架构图

```
                        ┌──────────────────────────┐
                        │      cli.tsx (302行)      │ ← Layer 1: CLI 引导
                        │    fast-path 分发 + 启动   │
                        └────────────┬─────────────┘
                                     │ default path
                                     ▼
                        ┌──────────────────────────┐
                        │     main.tsx (4683行)     │ ← Layer 2: 总入口
                        │  run() → init() → setup() │
                        │   → REPL / Headless 分发  │
                        └────────────┬─────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
    ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
    │  REPL (交互式)   │   │  Headless (SDK)  │   │  --print (单次)  │
    │  launchRepl()    │   │  runHeadless()   │   │  runHeadless()   │
    └────────┬────────┘   └────────┬────────┘   └────────┬────────┘
             │                     │                      │
             └─────────────────────┼──────────────────────┘
                                   │
                                   ▼
                        ┌──────────────────────────┐
                        │   QueryEngine.ts (1295行) │ ← Layer 3: 会话外壳
                        │  submitMessage() 生命周期  │
                        │  双消息数组 + SDK 桥接     │
                        └────────────┬─────────────┘
                                     │
                                     ▼
                        ┌──────────────────────────┐
                        │     query.ts (1729行)      │ ← Layer 4: 核心循环
                        │  queryLoop() while(true)   │
                        │  7 个 continue 站点        │
                        └────────────┬─────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
    ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
    │  服务层          │   │  工具系统        │   │  权限系统        │
    │  toolExecution   │   │  Tool.ts(792行)  │   │  permissions   │
    │  streamingExec   │   │  tools.ts(389行) │   │  canUseTool    │
    │  compact/*      │   │  buildTool工厂   │   │  7种权限模式    │
    │  mcp/*          │   │  12阶段执行管道  │   │  12步权限检查   │
    └─────────────────┘   └─────────────────┘   └─────────────────┘
```

---

## 一、入口层：cli.tsx → main.tsx

### 1.1 cli.tsx — 6 层启动

**文件**：`entrypoints/cli.tsx`（302行）

```
cli.tsx:33  main() 入口
  │
  ├── L37-42   --version / -v / -V → 立即退出（零 import）
  ├── L53-71   --dump-system-prompt → 渲染 + 退出
  ├── L79-93   --claude-in-chrome-mcp / --computer-use-mcp → MCP server
  ├── L100-106 --daemon-worker → 守护进程
  ├── L112-162 remote-control / rc / bridge → bridge 服务器
  ├── L165-180 daemon → 长驻进程
  ├── L185-208 ps / logs / attach / kill / --bg → 会话管理
  ├── L248-274 --worktree --tmux → exec 进 tmux（快速路径）
  │
  └── L288-298 [默认路径]
       ├── startCapturingEarlyInput()      ← 提前捕获键盘输入
       └── import('../main.js')            ← 动态加载主入口
            └── cliMain() → main()
```

关键设计：**18 条快速路径**在加载完整 CLI 之前就返回了。只有"正常交互"才走完整初始化。

### 1.2 main.tsx — 总入口

**文件**：`main.tsx`（4683行）

**模块级副作用**（import 时立即执行）：
- `startMdmRawRead()` — 读 macOS MDM 配置（并行于其他 import）
- `startKeychainPrefetch()` — 预读 macOS 钥匙串中的 API key（并行）

**`main()` 函数流程**（L585）：

```
main()
  │
  ├── L594-607   信号处理（SIGINT + process.exit 清理）
  ├── L612-642   cc:// / cc+unix:// URL 改写
  ├── L685-700   Assistant 模式（Kairos）：检测 + 剥离参数
  ├── L706-795   SSH 远程模式：提取 host + dir + SSH 选项
  ├── L799-812   判断交互/非交互（-p / --print / --sdk-url / !isTTY）
  ├── L818-834   判断客户端类型（github-action / sdk-* / vscode / desktop / cli）
  ├── L852       eagerLoadSettings() — 提前解析 --settings 和 --setting-sources
  │
  └── L884       run()
       │
       ├── L902-903   Commander 命令行解析器
       ├── L907-967   preAction 钩子（每个命令执行前运行）:
       │   ├── ensureMdmSettingsLoaded()     ← MDM 子进程结果
       │   ├── ensureKeychainPrefetchCompleted() ← 钥匙串结果
       │   ├── init()                        ← ★ 核心初始化
       │   ├── initSinks()                   ← 日志 + 遥测
       │   ├── runMigrations()               ← 数据迁移
       │   └── loadRemoteManagedSettings()   ← 企业管理配置（非阻塞）
       │
       ├── L968-1006  注册全部 CLI 选项（--model, --permission-mode, --mcp-config 等 30+ 个）
       │
       └── L1006      .action() 回调（主命令处理）:
            │
            ├── L1389-1777  权限初始化
            │   ├── initialPermissionModeFromCLI()
            │   ├── initializeToolPermissionContext()
            │   └── 危险权限剥离（auto 模式）
            │
            ├── L1778-1900  MCP 配置加载 + 工具获取
            │   ├── getClaudeCodeMcpConfigs()
            │   ├── getTools(toolPermissionContext)
            │   └── assembleToolPool()
            │
            ├── L1903-1936  ★ 关键并行段:
            │   ├── setup()                  ← 4.1 节
            │   ├── getCommands(cwd)          ← 并行
            │   └── getAgentDefinitions(cwd)  ← 并行
            │
            ├── L2380-2448  MCP 连接 + SessionStart hooks
            │
            └── L2585+  分支:
                 ├── --init-only → 运行 hooks → 退出
                 ├── --print → runHeadless()
                 └── [默认] → launchRepl()（交互式 Ink TUI）
```

### 1.3 init() — 一次性初始化

**文件**：`entrypoints/init.ts`

`init = memoize(async () => ...)` — 整个进程生命周期只跑一次。

```
init()
  ├── enableConfigs()                    ← 解析 settings.json（用户/项目/本地）
  ├── applySafeConfigEnvironmentVariables() ← 安全的 env var（不含 PATH/LD_PRELOAD）
  ├── setupGracefulShutdown()            ← 注册退出处理
  ├── [void] 遥测初始化（1P events, Growthbook）
  ├── [void] OAuth 账户信息
  ├── [void] JetBrains 检测
  ├── globalMTLS + globalAgents          ← TLS 代理配置（必须在任何网络连接前）
  ├── preconnectAnthropicApi()           ← ★ TCP+TLS 预连接（节省 ~200ms）
  ├── [void] LSP manager 注册
  ├── [void] Swarm team cleanup 注册
  └── initializeTelemetryAfterTrust()    ← OpenTelemetry（惰性加载 ~400KB）
```

### 1.4 setup() — 会话级初始化

**文件**：`setup.ts`

```
setup()
  ├── Node.js 版本检查（≥18）
  ├── UDS 消息服务器启动（IPC 通信）
  ├── 终端备份恢复（iTerm2 + Terminal.app）
  ├── setCwd(cwd)                       ← ★ 后续所有代码依赖此调用
  ├── captureHooksConfigSnapshot()      ← 钩子配置快照
  ├── [可选] worktree 创建 + tmux 会话
  ├── [后台] initSessionMemory()
  ├── [后台] initContextCollapse()
  ├── [预取] getCommands() / loadPluginHooks()
  ├── initSinks()                       ← 日志排水
  ├── tengu_started 事件                 ← 最早的进程启动信号
  ├── API key 预取（安全方式）
  └── 权限安全门（bypass 模式下检查 root/Docker/无网络）
```

---

## 二、查询循环层：QueryEngine → query.ts

### 2.1 QueryEngine — 会话外壳

**文件**：`QueryEngine.ts`（1295行）

QueryEngine 是一个类，每个对话一个实例。它是**内部 Agent 系统**和**外部 SDK 接口**之间的适配器。

**关键私有字段**：

| 字段 | 作用 |
|------|------|
| `mutableMessages` | 持久消息存储，跨 turn 存活 |
| `permissionDenials` | 所有被拒绝的工具调用记录 |
| `totalUsage` | 累计 token 用量 |
| `readFileState` | 文件内容缓存（LRU） |
| `abortController` | 取消信号 |

**submitMessage() 生命周期**：

```
submitMessage(userInput)
  │
  ├── Phase 1: 预处理
  │   ├── processUserInput()         ← 斜杠命令/附件/图片/Agent 提及
  │   ├── fetchSystemPromptParts()   ← systemPrompt + userContext + systemContext
  │   └── 注册 structured output hook
  │
  ├── Phase 2: 孤儿权限恢复（仅首次）
  │   └── handleOrphanedPermission() ← 恢复上一个会话中断的权限决定
  │
  ├── Phase 3: 用户消息持久化（★ 关键——先写盘再调 API）
  │   └── recordTranscript(messages) ← 确保 --resume 能恢复断连前的对话
  │
  ├── Phase 4: 进入 query() 循环
  │   └── for await (msg of query({...})) { ... }
  │        │
  │        ├── 'assistant' → 推入 mutableMessages + 产出 SDK 消息
  │        ├── 'user'      → 推入 mutableMessages
  │        ├── 'progress'  → 推入 mutableMessages（bash 进度限流 30s）
  │        ├── 'stream_event' → 累计 usage
  │        ├── 'system/compact_boundary' → 剪切 pre-boundary 消息（释放内存）
  │        └── 'attachment/structured_output' → 捕获结构化输出
  │
  ├── Phase 5: 结果组装
  │   ├── isResultSuccessful()       ← 判断是否有意义输出
  │   ├── 收集 usage + cost + permission_denials
  │   └── yield result/success
  │
  └── Phase 6: 清理
      └── flushSessionStorage()      ← 强制刷盘
```

**关键设计：双消息数组**
- `this.mutableMessages` — 持久存储，跨 turn 存活
- `messages`（局部副本） — 传给 query()，query 在里面追加 assistant/progress/attachment

**关键设计：预循环持久化**
用户消息在**进入查询循环之前**就写入转录。如果进程在 API 响应前被杀，`--resume` 仍能找到对话。

### 2.2 query.ts — 核心 Agent 循环

**文件**：`query.ts`（1729行）

这是 Claude Code 的心脏。架构概要：

```
query() [L219] — 入口（处理命令生命周期通知）
  │
  └── queryLoop() [L241] — while(true) 循环
       │
       ├── [每次迭代]
       │   ├── 1. 解构 state（不可变模式）
       │   ├── 2. 压缩管道（snip → microcompact → collapse → autocompact）
       │   ├── 3. 阻塞限制检查
       │   ├── 4. deps.callModel() [L659] → streaming for-await
       │   │    ├── 每个 chunk: 提取 tool_use → StreamingToolExecutor.addTool()
       │   │    ├── 流式降级处理（回退到非流式调用）
       │   │    └── 模型回退（429/5xx → fallbackModel）
       │   ├── 5. needsFollowUp?
       │   │    ├── YES → 执行工具 → 收集结果 → 收集附件 → continue
       │   │    └── NO  → 413恢复 / max_tokens恢复 / stop hooks / budget → return
       │   └── 6. state = { ...next } → continue
```

#### 不可变状态模式

```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  turnCount: number
  transition: Continue | undefined    // 为什么上一轮 continue 了
  // ... 恢复状态字段
}
```

每次 continue 不是 mutate 单个字段，而是创建一个全新 State：

```typescript
const next: State = {
  ...state,                        // 复制所有旧字段
  messages: [...msgs, ...assistant, ...toolResults],  // 覆盖
  turnCount: nextTurnCount,        // 覆盖
  transition: { reason: 'next_turn' },
}
state = next
continue
```

TypeScript 会确保你覆盖了 State 类型的每一个字段——少写一个就编译报错。

#### 7 个 Continue 站点

| # | 原因 | 触发条件 | 行号 |
|---|------|---------|------|
| 1 | `collapse_drain_retry` | 413 错误 → 排空上下文折叠 → 重试 | L1099 |
| 2 | `reactive_compact_retry` | 413/媒体错误 → 完整压缩 → 重试 | L1152 |
| 3 | `max_output_tokens_escalate` | 输出 token 达 8k 上限 → 升级到 64k | L1207 |
| 4 | `max_output_tokens_recovery` | 升级后仍超 → 注入"继续"消息（最多 3 次） | L1231 |
| 5 | `stop_hook_blocking` | Stop 钩子返回阻塞错误 → 注入反馈 | L1283 |
| 6 | `token_budget_continuation` | token 预算剩余 → 注入催促消息 | L1321 |
| 7 | `next_turn` | 正常：工具结果已注入 → 下一轮 LLM 调用 | L1715 |

### 2.3 模型调用与流式处理

**文件**：`services/api/claude.ts`（3419行）

```
query.ts:659  deps.callModel({...})
  │
  └── claude.ts:752  queryModelWithStreaming()
       └── claude.ts:770  withStreamingVCR(queryModel)  ← 录制/回放测试
            └── claude.ts:1017  queryModel()
                 │
                 ├── 构建 betas / thinking / max_tokens / tools
                 ├── normalizeMessagesForAPI()  ← 归一化为 API 格式
                 │
                 └── claude.ts:1778  withRetry()
                      └── anthropic.beta.messages.create({
                            stream: true,
                            model, messages, system, tools, ...
                          })
                           │
                           ▼
                      SSE 事件流 (claude.ts:1940)
                      for await (part of stream):
                        ├── message_start         → 记录 TTFB + usage
                        ├── content_block_start   → 分配 contentBlocks[index]
                        ├── content_block_delta   → 累加 input_json_delta / text_delta
                        ├── content_block_stop    → ★ 创建 AssistantMessage + yield
                        └── message_delta         → 写回 usage + stop_reason

流式降级（claude.ts:2504）:
  如果流失败（非 529 错误 / 空闲看门狗）:
    ├── didFallBackToNonStreaming = true
    └── executeNonStreamingRequest()  ← 非流式 API 调用作为备份
```

**关键**：`content_block_stop` 事件触发时，每个完成的 content block（包括 tool_use）被包装成 `AssistantMessage` 并通过 `yield` 返回给 query.ts。query.ts 收到后立即提取 tool_use blocks → 喂给 StreamingToolExecutor → 工具开始执行，**此时 LLM 可能还在流后续内容**。

---

## 三、服务层

### 3.1 工具执行管道 — toolExecution.ts

**文件**：`services/tools/toolExecution.ts`（1745行）

`runToolUse()` 是每个工具调用的异步生成器。完整 12 阶段：

```
Stage 0: 工具查找
  └── findToolByName(tools, name) → 未找到则查别名 → 仍无: error

Stage 1: 中止检查
  └── abortController.signal.aborted? → 取消

Stage 2: Zod 输入校验
  └── tool.inputSchema.safeParse(input)
       └── 失败 → InputValidationError + deferred tool hint

Stage 3: 业务校验
  └── tool.validateInput?(parsedInput, context)
       └── 失败 → error

Stage 4: 推测性 Bash 分类（并行优化）
  └── 仅 Bash: startSpeculativeClassifierCheck()
       在权限对话框出现之前就开始跑分类器

Stage 5: Backfill Observable Input
  └── 浅克隆 input → tool.backfillObservableInput?(clone)
       不修改 API 绑定的原始 input

Stage 6: PreToolUse Hooks
  └── runPreToolUseHooks()
       ├── message: 钩子进度/附件
       ├── hookPermissionResult: allow/deny/ask
       ├── hookUpdatedInput: 修改 input（透传）
       └── preventContinuation/stop: 阻止继续执行

Stage 7: 权限决策
  └── resolveHookPermissionDecision()
       ├── 钩子 allow? → checkRuleBasedPermissions()（deny/ask 规则仍然覆盖）
       ├── 钩子 deny?  → 最终 deny
       └── 无钩子决定? → canUseTool()（详见 §5）

Stage 8: 工具执行
  └── tool.call(callInput, context, canUseTool, assistantMessage, onProgress)
       注意: callInput 可能已被 hooks/permissions 修改

Stage 9: 结果处理
  └── tool.mapToolResultToToolResultBlockParam(data, toolUseID)
       → processToolResultBlock()（大结果持久化到磁盘）
       → 组装 content blocks: tool_result + feedback + images

Stage 10: PostToolUse Hooks
  └── runPostToolUseHooks()
       ├── MCP 工具: 钩子先跑 → 可修改 updatedMCPToolOutput
       ├── 非 MCP: 结果先出 → 钩子后跑
       └── preventContinuation → hook_stopped_continuation attachment

Stage 11: 错误处理
  └── catch:
       ├── McpAuthError → 标记 server needs-auth
       ├── AbortError → 静默
       └── 其他 → runPostToolUseFailureHooks() + error tool_result
```

### 3.2 StreamingToolExecutor — 流式工具执行

**文件**：`services/tools/StreamingToolExecutor.ts`（531行）

在 LLM 还在流式传输时，工具就已经开始执行。

**数据结构**：
```typescript
interface TrackedTool {
  id, block, assistantMessage
  status: 'queued' | 'executing' | 'completed' | 'yielded'
  isConcurrencySafe: boolean
  promise, results[], pendingProgress[], contextModifiers[]
}
```

**核心算法**：

```
addTool(block) → 入队 → processQueue()
  │
  └── processQueue():
       遍历 queued 工具:
         如果 canExecute → executeTool()
         如果是非并发安全的工具在执行中 → break（阻塞队列）
  
  executeTool():
    ├── 创建 per-tool child AbortController
    ├── runToolUse()（12 阶段管道，见 §3.1）
    ├── 逐条收集 messages + contextModifiers
    ├── Bash 工具出错 → 中止所有 sibling
    └── 完成 → 标记 'completed' → processQueue() 解锁后续工具

  getCompletedResults(): 非阻塞同步产出已完成工具的结果
  getRemainingResults(): 等待所有工具完成（用于流式结束后）
```

**并发规则**：
- `isConcurrencySafe` 工具（Read/Glob/Grep/WebSearch/WebFetch）→ 任意并行
- 非并发安全工具（Bash/Write/Edit）→ 独占执行，阻塞队列
- 默认假设：`isConcurrencySafe() = false`（安全优先）

### 3.3 工具编排 — toolOrchestration.ts

**文件**：`services/tools/toolOrchestration.ts`

`runTools()` 是批量工具编排器（非流式降级路径）：

```
runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
  │
  ├── partitionToolCalls(): 将工具按并发安全性分区
  │    [Read, Read, Grep](并发) → [Bash](串行) → [Read, Grep](并发)
  │
  ├── runToolsConcurrently(): 并行批次 → 最大并发 10
  │    (CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY 可覆盖)
  │
  └── runToolsSerially(): 串行工具逐一执行
       contextModifier 从上一工具传给下一工具
```

### 3.4 上下文压缩 — 6 层防线

**文件**：`services/compact/`（11 个文件）

```
每次 API 调用前（query.ts L365-467）:

  1. getMessagesAfterCompactBoundary()   ← 切除压缩边界前的历史
  2. applyToolResultBudget()             ← 截断大型工具结果
  3. snipCompactIfNeeded()               ← 删除语义过时的片段
  4. microcompact()                      ← 清除旧工具结果内容（保留占位）
       ├── 时间触发: 最后 assistant 消息 > 60 分钟
       ├── 缓存 API: cache_edits 策略
       └── COMPACTABLE_TOOLS: Read/Grep/Glob/WebSearch/WebFetch/Edit/Write/shell
  5. applyCollapsesIfNeeded()            ← 上下文折叠投影
  6. autocompact()                       ← 完整对话摘要
       ├── shouldAutoCompact(): tokens ≥ contextWindow - 13000
       ├── 优先 trySessionMemoryCompaction()（更轻量）
       ├── 降级 compactConversation()（完整摘要）
       └── 电路断路器: 连续 3 次失败 → 停止尝试
```

**autocompact 工作流**：
```
compactConversation(messages, context)
  ├── PreCompact hooks
  ├── runForkedAgent()  ← 复用 prompt cache, max 200K output
  │    └── prompt-too-long? → truncateHeadForPTLRetry() → 重试
  ├── 清理: readFileState + file attachments + agent listing + skill listing
  ├── 生成 compactBoundaryMessage（标记压缩边界）
  ├── PostCompact hooks
  └── 返回 { boundaryMarker, summaryMessages, attachments }
```

**关键配置**：
- `AUTOCOMPACT_BUFFER_TOKENS = 13,000`
- `WARNING_THRESHOLD_BUFFER_TOKENS = 20,000`
- `MAX_CONSECUTIVE_FAILURES = 3`
- `COMPACT_MAX_OUTPUT_TOKENS = 200,000`

### 3.5 MCP — 6 级配置源

**文件**：`services/mcp/config.ts` + `client.ts`

```
配置优先级（从低到高）:
  claudeai < plugin < user < project < local < enterprise

getClaudeCodeMcpConfigs():
  ├── enterprise 模式? → 仅返回 enterprise 服务器
  ├── plugin-only lock? → 跳过 user/project/local
  ├── 加载 plugins → dedupPluginMcpServers()
  │    签名去重: stdio:<command> / url:<url>
  │    手动声明的优先级 > 插件
  ├── 合并: dedupedPlugin < user < approvedProject < local
  └── 策略过滤: isMcpServerAllowedByPolicy()

MCP 传输类型:
  stdio | sse | http | ws | sdk | claudeai-proxy
```

---

## 四、工具系统：Tool.ts + tools.ts

### 4.1 Tool 接口

**文件**：`Tool.ts`（792行）

Tool 是泛型接口 `Tool<Input, Output, Progress>`:

```
┌──────────────────────────────────────────────────┐
│                 Tool 接口（完整）                   │
├──────────────────────────────────────────────────┤
│ 身份:     name, aliases?, searchHint?, mcpInfo?  │
│ Schema:   inputSchema(Zod), inputJSONSchema?,     │
│           outputSchema?, inputsEquivalent?()      │
│ 安全:     isEnabled(), isReadOnly(),              │
│           isConcurrencySafe(), isDestructive()    │
│           isOpenWorld?(), strict?                 │
│ 生命周期: validateInput?(), checkPermissions?()   │
│           requiresUserInteraction?()              │
│           interruptBehavior?()                    │
│ 执行:     call(args, ctx, canUseTool, msg, prog)  │
│ 渲染:     renderToolUseMessage()                  │
│           renderToolResultMessage()               │
│           renderToolUseProgressMessage()          │
│           getToolUseSummary?()                    │
│           userFacingName?()                       │
│           ... 共 15+ 个 UI 方法                    │
└──────────────────────────────────────────────────┘
```

**buildTool 工厂**：`ToolDef` 把常用方法标为可选，`buildTool()` 填入安全默认值：

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,    // ★ 默认不并发（安全优先）
  isReadOnly: () => false,           // ★ 默认有写权限
  isDestructive: () => false,
  checkPermissions: () => ({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: () => '',
  userFacingName: (input) => def.name,
}
```

**ToolUseContext**：每个工具调用时可访问的完整上下文（~25 个字段），包括：
- 工具列表、MCP clients、Agent 定义
- abortController、文件状态缓存、权限上下文
- 消息历史、钩子回调、通知队列

### 4.2 工具注册与过滤

**文件**：`tools.ts`（389行）

```
getAllBaseTools()
  │  列出全部工具（~40 个），按 feature flag / env var 条件展开
  │
  ├── getTools(permissionContext)  ← 按模式过滤
  │   ├── Simple 模式: 仅 [Bash, Read, Edit]
  │   ├── Normal 模式: getAllBaseTools → filterToolsByDenyRules
  │   └── REPL 模式: 隐藏底层工具（在 REPL 内部可用）
  │
  └── assembleToolPool(permissionContext, mcpTools)
       ├── getTools() + MCP 工具过滤
       ├── 分区排序（内置在前，MCP 在后）← 稳定 prompt cache
       └── uniqBy name（内置优先）
```

---

## 五、权限系统

### 5.1 7 种权限模式

**文件**：`types/permissions.ts` + `utils/permissions/PermissionMode.ts`

| 模式 | 对外 | 效果 |
|------|------|------|
| `default` | ✅ | 正常弹窗 |
| `acceptEdits` | ✅ | 自动接受工作目录内的编辑 |
| `plan` | ✅ | 只读规划，工具受限 |
| `bypassPermissions` | ✅ | 跳过全部（deny 规则 + 安全检查除外） |
| `dontAsk` | ✅ | 把所有 ask 自动转 deny |
| `auto` | ❌ (内部) | AI 分类器决定 allow/deny |
| `bubble` | ❌ (内部) | 子 Agent 权限冒泡到父终端 |

**模式循环**（Shift+Tab）：`default → acceptEdits → plan → bypassPermissions → default`

### 5.2 权限检查管道 — 12 步

**文件**：`utils/permissions/permissions.ts`（1486行）

```
hasPermissionsToUseTool(tool, input, context)
  │
  ├── hasPermissionsToUseToolInner() ← 核心规则检查
  │   ├── 1a. 整个工具的 deny 规则? → deny
  │   ├── 1b. 整个工具的 ask 规则? → ask
  │   ├── 1c. tool.checkPermissions() ← 工具自定义权限
  │   ├── 1d. 工具返回 deny? → deny
  │   ├── 1e. requiresUserInteraction? → 绕过所有检查
  │   ├── 1f. 内容级 ask 规则? → ask（覆盖 bypass）
  │   ├── 1g. 安全检查（.git/.claude/shell 配置）→ ask（覆盖 bypass）
  │   ├── 2a. bypassPermissions 模式? → allow
  │   ├── 2b. 整个工具的 allow 规则? → allow
  │   └── 3. 默认: passthrough → ask
  │
  └── 后处理:
       ├── dontAsk 模式? → ask 转 deny
       ├── auto 模式? → classifyYoloAction()（AI 分类器）
       └── shouldAvoidPermissionPrompts? → 跑 PermissionRequest hooks
            → 无 hook 决定 → auto-deny
```

### 5.3 交互式权限 — 4 路竞速

**文件**：`hooks/toolPermission/handlers/interactiveHandler.ts`

当 `hasPermissionsToUseTool` 返回 `ask` 时，4 个异步路径同时竞争：

```
handleInteractivePermission()
  │
  ├── 竞速路径 1: 用户在终端按 Y/n → onAllow/onReject 回调
  ├── 竞速路径 2: 用户在 CCR（claude.ai 网页）响应 → claim() 抢跑
  ├── 竞速路径 3: 频道回复（Telegram/iMessage）→ claim() 抢跑
  ├── 竞速路径 4: Bash 分类器异步完成 → 自动批准
  └── PermissionRequest hooks 异步 → hook 决定

createResolveOnce() 保证谁先到谁赢——后续调用全是 no-op。
```

### 5.4 canUseTool 的线程路径

```
useCanUseTool hook (React/Ink)
  │  创建 CanUseToolFn + PermissionContext + 队列操作
  │
  ├── QueryEngine 包装（追踪拒绝记录）
  │    └── wrappedCanUseTool = async (...) => {
  │          result = await canUseTool(...)
  │          if (denied) this.permissionDenials.push(...)
  │          return result
  │        }
  │
  ├── query.ts 线程传递:
  │    ├── StreamingToolExecutor(canUseTool)
  │    └── runTools(canUseTool)
  │
  ├── Tool.call() 第三参数 ← 每个工具都能收到
  │    └── AgentTool: 传给子 Agent 的 runAgent()
  │         ├── 同步子 Agent: 共享父 abortController
  │         ├── 异步子 Agent: 独立 abortController + shouldAvoidPermissionPrompts
  │         └── Fork 子 Agent: permissionMode='bubble'（冒泡到父终端）
  │
  └── 子 Agent runAgent():
       └── createSubagentContext()
            ├── bubble 模式: shouldAvoidPermissionPrompts=false
            ├── 异步: shouldAvoidPermissionPrompts=true（默认）
            └── 异步 + canShowPermissionPrompts: awaitAutomatedChecksBeforeDialog=true
```

---

## 六、数据流全景：一个完整 turn

```
用户输入 "读一下 README.md"
  │
  ▼
main.tsx action()
  ├── processUserInput() → 解析斜杠命令/附件/图片
  ├── 写 transcript（★ 预循环持久化）
  │
  ▼
QueryEngine.submitMessage()
  ├── fetchSystemPromptParts()
  └── query({ messages, systemPrompt, canUseTool, tools, ... })
       │
       ▼
     queryLoop() while(true) {
       │
       ├── [压缩管道] autocompact? → compactConversation()
       │
       ├── [API 调用] deps.callModel({...})
       │    └── anthropic.beta.messages.create({stream:true})
       │         │
       │         ▼ SSE 流
       │         content_block_start(text)
       │         content_block_delta("我来读一下...")
       │         content_block_stop → yield {type:'assistant', content:[text]}
       │
       ├── [提取] tool_use blocks ← filter content by type==='tool_use'
       │
       ├── needsFollowUp = true
       │
       ├── [工具执行]
       │    ├── StreamingToolExecutor.addTool(Read, "README.md")
       │    │    └── runToolUse():
       │    │         ├── Zod 校验 ✓
       │    │         ├── validateInput ✓
       │    │         ├── PreToolUse hooks
       │    │         ├── canUseTool() → hasPermissionsToUseTool()
       │    │         │    ├── 无 deny 规则
       │    │         │    ├── bypassPermissions? → allow
       │    │         │    └── → allow ✓
       │    │         ├── tool.call() → readFileSync() → 156 行
       │    │         ├── PostToolUse hooks
       │    │         └── yield tool_result
       │    │
       │    └── toolResults = [{type:'user', content:[{type:'tool_result',...}]}]
       │
       ├── [状态更新]
       │    state = {
       │      messages: [...msgs, assistant, ...toolResults],
       │      turnCount: 1,
       │      transition: {reason:'next_turn'}
       │    }
       │    continue  ← 回到 while(true) 顶部
       │
       ├── [第二轮 API 调用]
       │    messages 现在 = [user:"读一下 README.md", assistant(含tool_use),
       │                      user(含tool_result: 156行内容)]
       │    → LLM 看到文件内容，生成回复
       │
       ├── needsFollowUp = false
       ├── stop hooks → 无阻塞
       └── return {reason:'completed'}
     }
```

---

## 七、关键数字

| 组件 | 文件 | 行数 |
|------|------|------|
| CLI 引导 | `entrypoints/cli.tsx` | 302 |
| 总入口 | `main.tsx` | 4,683 |
| 一次性初始化 | `entrypoints/init.ts` | ~300 |
| 会话初始化 | `setup.ts` | ~500 |
| 全局状态 | `bootstrap/state.ts` | ~430 |
| 会话外壳 | `QueryEngine.ts` | 1,295 |
| 核心循环 | `query.ts` | 1,729 |
| 模型调用 + 流式 | `services/api/claude.ts` | 3,419 |
| 工具执行管道 | `services/tools/toolExecution.ts` | 1,745 |
| 流式工具执行器 | `services/tools/StreamingToolExecutor.ts` | 531 |
| 工具接口 + 工厂 | `Tool.ts` | 792 |
| 工具注册 + 过滤 | `tools.ts` | 389 |
| 权限核心 | `utils/permissions/permissions.ts` | 1,486 |
| 权限交互处理 | `hooks/toolPermission/handlers/interactiveHandler.ts` | ~400 |
| 压缩核心 | `services/compact/compact.ts` | ~390 |
| MCP 配置 | `services/mcp/config.ts` | ~1,600 |
| MCP 客户端 | `services/mcp/client.ts` | ~3,400 |
| 系统提示词 | `constants/prompts.ts` | 914 |
| **核心总计** | | **~22,000** |

---

## 八、与 Mycoder 的架构对照

| 层 | Claude Code | Mycoder (当前) | 差距 |
|----|-------------|---------------|------|
| 入口 | 6 层启动（18 条快速路径） | Mycoder.ts 65 行 | Mycoder 不需要多入口 |
| 会话管理 | QueryEngine (1295行) SDK 桥接 | agent.ts Engine 类 (353行) | CC 多 SDK 消费者，Mycoder 单一 |
| 核心循环 | query.ts (1729行) 7 个恢复站点 | agent.ts run() 25轮循环 | CC 的容错 MyCoder 不需要 |
| 工具执行 | 12 阶段管道 + StreamingToolExecutor | Promise.all 内联 | CC 流式并行，Mycoder 批并行 |
| 权限 | 7 种模式 × 12 步管道 | 无（单人信任） | Mycoder 不需要 |
| 压缩 | 6 层防线 | 无 | Mycoder 上下文小，暂不需要 |
| 工具系统 | Tool 接口 30+ 方法 | Tool 接口 10 方法 | CC 多了 UI 渲染 + 权限集成 |
| MCP | 6 级配置源 × 6 种传输 | 22 行 stub | 需要时接入 |
| 提示词 | 914 行，缓存分段 | 40 行动态生成 | Mycoder 够用 |

**核心结论**：Claude Code 的 22,000 行核心代码中，~60% 是容错+安全+多用户+SDK 桥接。真正驱动 Agent 的逻辑（"调 LLM → 执行工具 → 下一轮"）只有 ~500 行。Mycoder 的 353 行 agent.ts 已经覆盖了这 500 行中最核心的部分。

