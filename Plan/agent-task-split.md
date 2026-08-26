# Agent-Task 拆分计划 — 完整详设

> **时间**：2026-08-02 | **状态**：计划

---

## 一、现状问题

当前 AgentTool 和 TaskTool 职责混乱：

| 问题 | 现象 |
|---|---|
| AgentTool 里的后台模式自己创建 Task、自己发通知、自己计数——和 TaskTool 重复 | 两个工具各自维护 Task 逻辑，修改一个漏另一个 |
| Task(create) 同时创建 Task 条目 + 启动子 Agent——结果 LLM 不知道传什么参数 | create 需要 subject + prompt，但这两个看起来差不多 |
| 子 Agent 在跑的时候，Task(check) 只能看 "(still running)" | 没法诊断卡住的 Agent 在读什么文件 |
| pendingNotifications 是内部队列，LLM 看不到 | Agent 不知道有几个通知在排队，只能等下轮被动收到 |
| 没有 kill——Agent 跑偏了只能等 10 轮超时 | 浪费 token |

---

## 二、拆分后的两个工具

### AgentTool — "谁去干"

LLM 的语义：**"我 spawn 一个 Agent 去处理这件事"**

| action | 输入 | 输出 | 说明 |
|---|---|---|---|
| `spawn` | description, prompt, type?, background? | agentId | 创建子Agent并开始执行 |

AgentTool 不再管 Task——它只负责启动 Agent。启动时自动在 Task 注册表里创建一条追踪记录，但 LLM 不需要传 subject/description 这些 Task 参数。

### TaskTool — "干到哪了"

LLM 的语义：**"让我看看这些任务的状态"**

| action | 输入 | 输出 | 说明 |
|---|---|---|---|
| `create` | subject, description | taskId | 纯创建追踪条目（不启动任何东西） |
| `list` | — | 所有任务的表格 | 状态/耗时/类型 |
| `check` | taskId | 任务详情 + 实时中间输出 | running 也能看到进度 |
| `wait` | timeout_ms? | 完成/超时状态 | 等所有 running 的任务 |
| `kill` | taskId | 确认 | abort 对应 Agent/Bash 进程 |
| `inbox` | — | 排队通知列表 | 不消费，只查看 |

---

## 三、数据结构设计

### 3.1 TaskState（增强版）

```typescript
interface TaskState {
  id: string;                    // "a" + 8位base36
  type: 'local_agent' | 'local_bash';
  status: 'running' | 'completed' | 'failed' | 'killed';
  
  // 基础信息
  subject: string;               // 人类可读标题, e.g. "调查生肖鼠"
  description?: string;          // 详细描述
  
  // 时间
  startTime: number;
  endTime?: number;
  
  // Agent 特有
  agentLoop?: {
    roundCount: number;          // 当前第几轮
    toolUseCount: number;        // 已经调了多少次工具
    lastActivity?: string;       // 最近一次工具调用摘要, e.g. "Read(src/main.ts)"
    lastOutput?: string;         // 最近一次工具输出的前200字符
  };
  
  // 输出
  output?: string;               // 完成后的完整输出
  
  // 控制
  abortController?: AbortController;  // 用于 kill
}
```

### 3.2 任务注册表（共享状态）

```typescript
// main.ts 里，所有工具通过注入访问
const taskRegistry = new Map<string, TaskState>();
const pendingNotifications: Array<{ role: string; content: string }> = [];
```

所有工具（AgentTool / TaskTool / BashTool）共享同一个 `taskRegistry` 和 `pendingNotifications`。通过 `initXxx()` 注入。

---

## 四、AgentTool 重构

### 4.1 输入 Schema

```typescript
const inputSchema = z.object({
  action: z.enum(['spawn']),     // 未来可加 'resume', 'stop'
  description: z.string(),       // Short (3-5 word) description
  prompt: z.string(),            // The task for the sub-agent
  subagent_type: z.enum(['general-purpose', 'explore']).optional(),
  run_in_background: z.boolean().optional(),
});
```

### 4.2 spawn 流程

```
Agent(spawn, description, prompt, ...)
  ↓
1. 生成 agentId
2. 在 taskRegistry 里创建 TaskState:
   { id: agentId, type: 'local_agent', status: 'running',
     subject: description, agentLoop: { roundCount: 0, toolUseCount: 0 } }
3. 创建 AbortController, 存入 taskState.abortController
4. buildSubAgentContext(prompt) → 构建子Agent的消息数组
5. 同步模式: await runSubAgent(messages, agentId)
   后台模式: spawn without await, 立即返回 agentId
6. 子Agent的 runSubAgent 每轮更新 taskState.agentLoop
7. 完成后:
   - completeTask(agentId, result) → 更新 status='completed', output=result
   - 通过 notify() 往 pendingNotifications 推一条消息
```

### 4.3 注入依赖

```typescript
export function initAgentTool(deps: {
  taskRegistry: Map<string, TaskState>;
  runSubAgent: (messages: any[], agentId: string) => Promise<string>;
  buildSubAgentContext: (task: string) => any[];
  notify: (msg: string) => void;
}) { ... }
```

---

## 五、TaskTool 重构

### 5.1 输入 Schema

```typescript
const inputSchema = z.object({
  action: z.enum(['list', 'check', 'wait', 'kill', 'inbox']),
  taskId: z.string().optional(),       // for check, kill
  timeout_ms: z.number().optional(),   // for wait
  subject: z.string().optional(),      // for create
  description: z.string().optional(),  // for create
});
```

### 5.2 六个 action 的详细逻辑

#### `list` — 展示所有任务

```
Task(list)
  ↓
遍历 taskRegistry.values()
  ↓
对每个 task:
  - running: "⏳ [running] a1b2c3d4: 调查生肖鼠 (round 3, 12 tools called, last: Read(foo.ts))"
  - completed: "✓ [completed] a1b2c3d4: 调查生肖鼠 (took 45s)"
  - killed: "✗ [killed] a1b2c3d4: 调查生肖鼠"
  ↓
返回汇总: "12 tasks: 3 running, 9 completed"
```

#### `check` — 查看单个任务

```
Task(check, taskId: "a1b2c3d4")
  ↓
从 taskRegistry 取出 task
  ↓
如果 status === 'running':
  → 返回: "[running] 调查生肖鼠
            Round 3/10, 12 tool calls
            Last activity: Read(src/data/rat.md)
            Last output: (前200字符)
            中间输出:
            Round 1: WebSearch("鼠生肖") → 5 results
            Round 2: WebFetch(url) → 2KB
            Round 3: Read(src/data/rat.md) → 156 lines"
  ↓
如果 status === 'completed':
  → 返回完整 output
```

#### `wait` — 等待完成

```
Task(wait, timeout_ms: 30000)
  ↓
轮询 taskRegistry (每秒一次) 直到:
  - 所有 running 任务都完成 → "All 12 tasks completed in 23s"
  - 超时 → "Timeout: 5 of 12 tasks still running: a1b2, a3c4, ..."
  ↓
返回结果后，LLM 可以决定:
  - 再等一会儿: Task(wait, timeout_ms: 60000)
  - 查看某个卡住的任务: Task(check, taskId: "a1b2c3d4")
  - 杀掉某个看起来没用的任务: Task(kill, taskId: "a1b2c3d4")
```

#### `kill` — 杀任务

```
Task(kill, taskId: "a1b2c3d4")
  ↓
从 taskRegistry 取出 task
  ↓
如果 task.abortController 存在 → abort()
如果 task.type === 'local_bash' → 杀子进程
  ↓
更新 status = 'killed'
  ↓
返回: "Task a1b2c3d4 (调查生肖鼠) killed"
```

#### `inbox` — 查看通知队列

```
Task(inbox)
  ↓
读取 pendingNotifications (不消费)
  ↓
返回: "3 pending notifications:
        1. [Agent "调查生肖鼠" completed]: 鼠是十二生肖之首...
        2. [Agent "调查生肖牛" completed]: 牛排第二，勤奋踏实...
        3. [Agent "调查生肖虎" completed]: 虎排第三，威猛自信..."
  ↓
LLM 看到后可以决定:
  - "3个完成了，我先把这些结果整合一下" → 等 flush
  - "还有9个在跑，我再等等" → Task(wait)
```

---

## 六、runSubAgent 增强（实时输出）

### 6.1 改动点

```typescript
async function runSubAgent(messages, agentId) {
  const task = taskRegistry.get(agentId);
  
  for (let i = 0; i < 10; i++) {
    // 检查是否被 kill
    if (task?.abortController?.signal.aborted) {
      completeTask(agentId, '(killed by user)');
      return '(killed)';
    }
    
    const response = await callLLM(SUB_AGENT_PROMPT, messages);
    
    if (response.stop_reason === 'end_turn') { ... }
    
    if (response.stop_reason === 'tool_use') {
      // 更新实时状态
      if (task?.agentLoop) {
        task.agentLoop.roundCount = i + 1;
        task.agentLoop.toolUseCount += response.content.filter(b => b.type === 'tool_use').length;
      }
      
      // 每个工具执行完, 更新 lastActivity + lastOutput
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const tool = toolMap.get(block.name);
          const summary = tool?.getToolUseSummary?.(block.input);
          if (task?.agentLoop) task.agentLoop.lastActivity = `${block.name}(${summary})`;
        }
        // 执行工具...
        if (task?.agentLoop) task.agentLoop.lastOutput = output.slice(0, 200);
      }
    }
  }
}
```

### 6.2 效果

现在 `Task(check, "a1b2c3d4")` 在 Agent 还在跑的时候就能看到：

```
[running] 调查生肖鼠
  Round 3/10, 12 tool calls
  Last: Read(src/data/rat.md) → 156 lines
```

而不是只能看到 "(still running)"。

---

## 七、通知队列增强

### 7.1 当前行为

```
Agent完成 → notify(msg) → push到 pendingNotifications
下轮用户输入 → flushNotifications() → 全部 push 到 sessionMessages
LLM在下轮开始时看到所有累积的通知
```

### 7.2 加上 inbox 后

```
Agent完成 → notify(msg) → push到 pendingNotifications

LLM: Task(inbox) → 看到: "3 pending"
LLM: "好, 3个完了, 还有9个在跑, 我继续等"
LLM: Task(wait, 30000) → 等了30秒
LLM: "又有5个完成了"
LLM: "算了不等了, 先把这8个的结果总结一下"
↓
此时用户输入触发 flush → 8个通知全部注入
LLM 看到所有结果 → 总结
```

LLM 有了**主动权**——不是被动等到下轮才知道，而是可以主动查 `inbox`、决定等多久、要不要提前总结。

---

## 八、实施步骤

### Step 1：增强 TaskState + taskRegistry（~30行）
- 添加 `agentLoop`、`abortController` 字段
- 不改任何工具逻辑，只加数据结构

### Step 2：重构 TaskTool（~150行）
- 保留: list, wait（逻辑不变）
- 改造: check — 显示实时中间输出
- 新增: kill — abort + 状态更新
- 新增: inbox — 读取 pendingNotifications
- 删除: create 中的 Agent 启动逻辑 → 纯创建追踪条目

### Step 3：重构 AgentTool（~80行）
- 简化为单一 spawn action
- 自动创建 TaskState
- 注入 AbortController
- 后台模式用 notify() 发通知

### Step 4：增强 runSubAgent（~30行）
- 每轮更新 agentLoop
- 检查 abort signal

### Step 5：初始化（~20行）
- main.ts 注入所有依赖
- 注册 2 个工具（Agent + Task）

### Step 6：测试
- 开 5 个 Agent 并行调查 → Task(list) 看进度 → Task(check) 看实时输出
- Task(wait) 等全部完成 → 看 inbox 是否正常
- Task(kill) 杀一个卡住的 → 看是否停止

---

## 九、最终工具列表

| 工具 | action | 说明 |
|---|---|---|
| **Agent** | spawn | 启动子Agent（通用/探索） |
| **Task** | list | 列出所有任务 |
| | check | 查看任务详情+实时输出 |
| | wait | 等待任务完成（可超时） |
| | kill | 杀掉运行中的任务 |
| | inbox | 查看通知队列（不消费） |
| **Bash** | — | 支持 run_in_background → Task 追踪 |

---

## 十、和 Claude Code 的对齐

| Claude Code | 我们的 Task | 说明 |
|---|---|---|
| TaskCreateTool | Task(create 中不做Agent启动) | 简化：只创建追踪条目 |
| TaskListTool | Task(list) | 增强：显示 round/tool count |
| TaskGetTool | Task(check) | 增强：显示实时中间输出 |
| TaskOutputTool | Task(check) 的一部分 | 合并到 check 里 |
| TaskStopTool | Task(kill) | 新增 |
| TaskUpdateTool | — | 暂不需要（自动更新） |
| SendMessageTool | inbox 的一部分 | 查看通知队列，不发消息 |
