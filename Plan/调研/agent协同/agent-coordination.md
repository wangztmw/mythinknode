# Claude Code 主 Agent 与子 Agent 协同机制 — 完整拆解

> **日期**：2026-08-07
> **调研方式**：三路 Agent 并行读取源码——协同协议、提示词约束、通知流
> **源码**：`study/claude-code/claude-code-main/src/`

---

## 一、协同的本质：不是通信，是约束

Claude Code 的 Agent 集群能协同好，靠的不是复杂的 IPC 协议，而是**六层约束**：

```
约束层 1: Prompt 规则      ← 系统提示词里的硬性禁令
约束层 2: 简报规范         ← 怎么写子 Agent 的任务描述
约束层 3: 通知机制         ← 异步结果的回流格式
约束层 4: 角色分离         ← Coordinator 不写代码，Worker 不看对话
约束层 5: 并发纪律         ← 读并行、写串行、验证独立
约束层 6: 反模式清单       ← 明确告知模型"永远不要做 X"
```

---

## 二、约束层 1：Prompt 规则——六条铁律

这些规则直接嵌在系统提示词里，是模型必须遵守的。

### 铁律 1：永远不要委托理解（最重要的一条）

```
**Never delegate understanding.**
Don't write "based on your findings, fix the bug" or "based on the research, implement it."
Those phrases push synthesis onto the agent instead of doing it yourself.
Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
```

**源码位置**：`tools/AgentTool/prompt.ts` L112，在 Coordinator 提示词中重复出现

**为什么这是最重要的**：如果主 Agent 把"理解研究结果 → 决定怎么做"这一步也委托给了子 Agent，那子 Agent 和主 Agent 就没有区别了。主 Agent 的价值恰恰在于**综合多个子结果、做出决策**。

**反例 vs 正例**：

```
❌ Agent({ prompt: "Based on your findings, fix the auth bug" })
❌ Agent({ prompt: "The worker found an issue in the auth module. Please fix it." })

✅ Agent({ prompt: "Fix the null pointer in src/auth/validate.ts:42.
     The user field on Session (src/auth/types.ts:15) is undefined when
     sessions expire but the token remains cached. Add a null check
     before user.id access — if null, return 401 with 'Session expired'.
     Commit and report the hash." })
```

区别：第一个把"理解"扔给了子 Agent。第二个证明主 Agent 已经读懂了研究结果：文件名、行号、具体字段、具体改动。

### 铁律 2：不要 peek——不要偷看子 Agent 的中间输出

```
**Don't peek.**
The tool result includes an output_file path — do not Read or tail it unless
the user explicitly asks for a progress check. You get a completion notification;
trust it. Reading the transcript mid-flight pulls the fork's tool noise into
your context, which defeats the point of forking.
```

**源码位置**：`tools/AgentTool/prompt.ts` L91

**为什么**：你 spawn 子 Agent 就是为了**不污染自己的上下文**。如果又去 Read 它的输出文件，等于把它的工具调用噪音全部拉进自己的 messages 数组——前功尽弃。

### 铁律 3：不要捏造——没收到结果前什么都不准说

```
**Don't race.**
After launching, you know nothing about what the fork found.
Never fabricate or predict fork results in any format — not as prose, summary,
or structured output.
```

**源码位置**：`tools/AgentTool/prompt.ts` L93，Coordinator L140 重复

### 铁律 4：不要轮询——等通知就行

```
When an agent runs in the background, you will be automatically notified when it
completes — do NOT sleep, poll, or proactively check on its progress.
```

**源码位置**：`tools/AgentTool/prompt.ts` L263

### 铁律 5：不要重复子 Agent 的工作

```
Importantly, avoid duplicating work that subagents are already doing —
if you delegate research to a subagent, do not also perform the same searches
yourself.
```

**源码位置**：`constants/prompts.ts` L319

### 铁律 6：子 Agent 的输出应该被信任

```
The agent's outputs should generally be trusted.
```

**源码位置**：`tools/AgentTool/prompt.ts` L268

---

## 三、约束层 2：简报规范——怎么写子 Agent 的任务描述

### 背景：子 Agent 看不到你的对话

```
Brief the agent like a smart colleague who just walked into the room —
it hasn't seen this conversation, doesn't know what you've tried,
doesn't understand why this task matters.
```

**源码位置**：`tools/AgentTool/prompt.ts` L103

**必须包含的信息**：
1. 你要达成什么目标，为什么
2. 你已经试过什么 / 排除过什么
3. 足够的上下文让它能做判断（而非机械执行指令）
4. 如果只要简短回复，明确说（"report in under 200 words"）
5. 查找任务：给精确命令。调查任务：给问题（预设步骤在前提错误时会失效）

**对 Fork（继承上下文的子 Agent）的区别**：

```
Since the fork inherits your context, the prompt is a *directive* — what to do,
not what the situation is. Be specific about scope: what's in, what's out,
what another agent is handling. Don't re-explain background.
```

### 目的声明——帮子 Agent 校准深度

```
Include a brief purpose so workers can calibrate depth and emphasis:
- "This research will inform a PR description — focus on user-facing changes."
- "I need this to plan an implementation — report file paths, line numbers, type signatures."
- "This is a quick check before we merge — just verify the happy path."
```

**源码位置**：`coordinator/coordinatorMode.ts` L274-278

### 继续还是新建？——按上下文重叠度决定

```
| 情况 | 操作 | 原因 |
|------|------|------|
| 研究刚好覆盖要改的文件 | SendMessage 继续 | Worker 已有文件在上下文 |
| 研究很广但实现很窄 | 新建 Agent | 避免拖着一堆探索噪音 |
| 纠错或扩展最近的工作 | SendMessage 继续 | Worker 有错误上下文 |
| 验证别人写的代码 | 新建 Agent | 需要全新视角 |
| 首次尝试用了错误方法 | 新建 Agent | 错误方法的上下文会污染重试 |
```

**源码位置**：`coordinator/coordinatorMode.ts` L284-287

---

## 四、约束层 3：通知机制——子 Agent 的结果怎么回流

### 通知的 XML 格式

**源码位置**：`tasks/LocalAgentTask/LocalAgentTask.tsx` L252-257

```xml
<task-notification>
  <task-id>a1b2c3d4</task-id>
  <tool-use-id>call_00_xxx</tool-use-id>
  <output-file>/tmp/tasks/a1b2c3d4.txt</output-file>
  <status>completed</status>
  <summary>Agent "调查生肖鼠" completed</summary>
  <result>鼠是十二生肖之首，象征机智和灵活性...</result>
  <usage>
    <total_tokens>8500</total_tokens>
    <tool_uses>12</tool_uses>
    <duration_ms>45000</duration_ms>
  </usage>
</task-notification>
```

### 从完成到入队到注入的完整链路

```
子 Agent 完成
  │
  ├── finalizeAgentTool()       ← 构建 AgentToolResult
  ├── completeAgentTask()       ← 状态 → 'completed'
  └── enqueueAgentNotification() ← 构建 XML
       │
       ▼
  commandQueue.push({           ← 全局消息队列
    mode: 'task-notification',
    priority: 'later'           ← 用户输入优先，通知不会饿死但可排队
  })
       │
       ▼ [下一轮主 Agent 循环]
  query.ts: getCommandsByMaxPriority()
    → getAttachmentMessages()
    → getQueuedCommandAttachments()
    → normalizeAttachmentForAPI()
       │
       ▼
  转换为 user 消息注入主 Agent 的 messages:
  <system-reminder>
  A background agent completed a task:
  <task-notification>...</task-notification>
  </system-reminder>
```

**关键设计**：
- 通知是 `priority: 'later'`——用户输入（`'next'`）先处理
- 通知被包装在 `<system-reminder>` 标签里——模型看到但 UI 隐藏
- 通知消息带有 `isMeta: true`——不计入对话转录展示
- `notified` 标志防止重复通知（TaskStop 和正常完成可能竞争）

### 运行中子 Agent 的进度怎么显示

与完成通知**不同路径**。在每轮 LLM 调用前的附件管道中：

```
generateTaskAttachments()
  ├── 遍历 AppState.tasks
  ├── running 任务 → getTaskOutputDelta()（从磁盘增量读取输出）
  └── 生成 task_status 附件 → 规范化为:
      "Background agent 'foo' (task-id) is still running. Progress: ...
       Do NOT spawn a duplicate..."
```

---

## 五、约束层 4：角色分离——Coordinator 不写代码，Worker 不看对话

这是 Coordinator 模式的核心设计：

```
Coordinator（主 Agent）
  │  角色: 理解用户意图、分配任务、综合结果、与用户沟通
  │  工具: Agent, SendMessage, TaskStop
  │  不能做: 直接修改代码（给 Worker 做）
  │
  └── Worker（子 Agent）
       角色: 执行具体任务（研究/实现/验证）
       工具: Bash, Read, Edit, Grep, Glob, WebSearch, WebFetch, MCP
       不能做: 看到用户对话、派生子 Agent、用 SendMessage
```

**源码位置**：`coordinator/coordinatorMode.ts`

Worker 被禁止使用的工具：
```typescript
const INTERNAL_WORKER_TOOLS = [
  'TeamCreate',   // 不能创建团队
  'TeamDelete',   // 不能删除团队
  'SendMessage',  // 不能给其他 Worker 发消息
  'SyntheticOutput',
]
```

### 四阶段任务工作流

```
Phase 1: Research    → Workers (并行)    → 调查代码库、找文件、理解问题
Phase 2: Synthesis   → Coordinator (自己) → 读懂发现、设计方案
Phase 3: Implementation → Workers        → 按方案改代码、提交
Phase 4: Verification   → Workers        → 验证改动有效
```

Synthesis 是最关键的一步——Coordinator **必须亲自做**，不能委托给 Worker。

---

## 六、约束层 5：并发纪律

```
Parallelism is your superpower.
Workers are async. Launch independent workers concurrently whenever possible.

- Read-only tasks (research) — run in parallel freely
- Write-heavy tasks (implementation) — one at a time per set of files
- Verification can sometimes run alongside implementation on different file areas
```

**源码位置**：`coordinator/coordinatorMode.ts`

**为什么写操作要串行**：两个 Worker 同时改同一组文件 → 冲突。CC 没有文件级锁，靠并发纪律来避免。

---

## 七、约束层 6：反模式清单——明确告诉模型"别做这些"

### 系统提示词里的反模式

```
❌ "Fix the bug we discussed"
   → 没有上下文，Worker 看不到你的对话

❌ "Based on your findings, implement the fix"
   → 懒惰委托——自己先综合研究发现

❌ "Create a PR for the recent changes"
   → 范围模糊：哪个改动？哪个分支？draft？

❌ "Something went wrong with the tests, can you look?"
   → 没有错误信息、没有文件路径、没有方向

❌ 用一个 Worker 检查另一个 Worker
   → Worker 会通知你，不要用 Agent 做 Task 的事

❌ 让 Worker 做琐碎的事（读一个文件、跑一个简单命令）
   → 自己用 Read/Bash 做，不要 spawn Agent

❌ Sleep / 轮询等待后台 Agent
   → 等通知就行，不要主动检查

❌ 偷看 Fork 的输出文件
   → 信任通知，不要 Read output_file
```

### Fork 子 Agent 的 10 条自约束

Fork 子 Agent 启动时会收到一段 boilerplate：

```
1. 不要派生子 Agent——直接执行
2. 不要对话、不要提问、不要建议下一步
3. 不要写评论或元评述
4. 直接使用工具：Bash, Read, Write 等
5. 如果修改了文件，提交后再报告——附带 commit hash
6. 工具调用之间不要输出文字——静默使用工具，最后一次性报告
7. 严格限制在指令范围内——最多一句话提及其他系统
8. 除非指令另有说明，否则报告不超过 500 字
9. 回复必须以 "Scope:" 开头——不要前言
10. 结构化报告事实，然后停止

输出格式:
Scope: <一句话回述你的任务范围>
Result: <答案或关键发现>
Key files: <相关文件路径>
Files changed: <改动列表 + commit hash>
Issues: <仅在有需要标记的问题时列出>
```

**源码位置**：`tools/AgentTool/forkSubagent.ts` L171-197

---

## 八、对 Mycoder 的实践建议

基于以上分析，Mycoder 要实现良好的 Agent 协同，**不需要复制 CC 的全部复杂度**，只需要五条核心约束：

### 1. 在系统提示词里嵌入"永远不要委托理解"

这是 CC 寻找的最重要一条规则。Mycoder 的 `buildSystemPrompt()` 里应该加：

```
使用 Agent 工具时：
- 子 Agent 看不到你的对话历史，只看到你给它的 prompt
- 写 prompt 时要包含：具体文件路径、行号、要改什么
- 禁止写 "based on your findings" ——你先理解结果，再写具体指令
- 研究任务给问题，实现任务给精确指令
```

### 2. 通知格式标准化

不必用 XML。Mycoder 的通知更简单（一个 JSON 字符串 push 进 `pendingNotifications`），但可以给规范格式：

```
[Agent "调查鼠" 完成] (45s, 12次工具调用)
结果: 鼠是十二生肖之首...
```

这样主 Agent 一眼就能看到：谁完成了、花了多久、干了什么、结果是什么。

### 3. 继续 vs 新建的基本判断

在 AgentTool 的 prompt 描述里加：

```
- 纠错或扩展上一个 Agent 的工作 → Task(direct) 继续（保留上下文）
- 完全不相关的任务 → 新建 Agent（干净上下文）
- 验证代码 → 新建 Agent（需要全新视角）
```

### 4. 并发规则

在系统提示词里加：

```
- 读操作（搜索/调研）→ 可并行
- 写操作（改代码）→ 同一组文件一次只让一个 Agent 改
```

### 5. 反模式清单

```
不要:
- 偷看子 Agent 的输出文件（等通知）
- 捏造子 Agent 的结果（没收到就是没收到）
- 轮询子 Agent 进度（等通知）
- 重复子 Agent 已经做过的工作
```

---

## 九、关键源文件索引

| 文件 | 核心内容 |
|------|---------|
| `tools/AgentTool/prompt.ts` | Agent 工具描述——简报规范、fork 规则、反模式 |
| `coordinator/coordinatorMode.ts` | Coordinator 角色定义——工作流、并发规则、四阶段 |
| `tools/AgentTool/forkSubagent.ts` | Fork 子 Agent 的 10 条自约束 + 输出格式 |
| `tasks/LocalAgentTask/LocalAgentTask.tsx` | 通知 XML 格式构建、进度追踪、生命周期 |
| `utils/task/framework.ts` | 通用任务框架——注册、轮询、驱逐 |
| `constants/prompts.ts` L316-395 | 系统提示词中的 Agent 规则（6 条铁律的源头） |
| `tools/SendMessageTool/` | Agent 间通信——按名发送、跨进程邮箱 |

---

## 十、总结

Claude Code 的 Agent 协同靠的不是复杂协议，而是**把"怎么配合"写死在提示词里**：

1. **主 Agent 负责理解**——"Never delegate understanding" 是一切的核心
2. **子 Agent 负责执行**——接收自包含的精确任务，不看不问不猜
3. **通知负责回流**——标准 XML 格式，异步注入，不偷看不捏造不轮询
4. **规则负责约束**——读并行写串行，继续还是新建按上下文重叠度判断
5. **反模式负责兜底**——明确列出"永远不要做的事"

Mycoder 不需要 CC 的 Coordinator 模式或 Fork 机制的全部复杂度。但从五条核心约束入手，就能让 Agent 集群从"能用"变成"用得好"。
