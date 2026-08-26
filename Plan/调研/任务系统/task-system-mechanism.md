# Claude Code 任务系统完整机制

> 源码路径：`study/claude-code/claude-code-main/src/`
> 调查范围：100+ 文件，5 路 Agent 并行分析

---

## 1. 核心发现：两套独立的任务系统

| | AppState 任务系统 | Disk Todo 系统 |
|---|---|---|
| **本质** | 后台进程跟踪器 | 模型的"便利贴" |
| **工具** | TaskOutputTool, TaskStopTool | TaskCreate, TaskUpdate, TaskList, TaskGet |
| **存储** | 内存 `AppState.tasks`，进程退出消失 | 磁盘 `~/.claude/tasks/{taskListId}/{id}.json` |
| **状态** | pending → running → completed/failed/killed | pending → in_progress → completed |
| **门控** | 始终可用 | `isTodoV2Enabled()` 功能开关 |
| **依赖** | 无依赖概念 | blockedBy / blocks 双向依赖 |

---

## 2. AppState 任务系统 —— 后台进程跟踪

### 2.1 核心文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `Task.ts` | 125 | 核心类型：`TaskType`(7种)、`TaskStatus`(5种)、`TaskStateBase`、`Task` 接口、`generateTaskId()` |
| `tasks.ts` | 39 | 注册表：`getAllTasks()`、`getTaskByType(type)` |
| `tasks/types.ts` | ~50 | 联合类型：`TaskState`、`BackgroundTaskState`、`isBackgroundTask()` |
| `tasks/LocalShellTask/LocalShellTask.tsx` | ~1600 | Bash 后台进程管理 |
| `tasks/LocalAgentTask/LocalAgentTask.tsx` | ~2000 | 本地子 Agent 管理 |
| `tasks/RemoteAgentTask/RemoteAgentTask.tsx` | ~3000 | 远程 Agent 管理 |
| `tasks/InProcessTeammateTask/InProcessTeammateTask.tsx` | ~400 | 进程内队友 Agent |
| `tasks/DreamTask/DreamTask.ts` | ~130 | Dream 异步队列任务 |
| `utils/task/framework.ts` | 309 | **运行时引擎**：注册、轮询、通知、GC |
| `utils/task/diskOutput.ts` | ~350 | 磁盘输出 I/O：写入、增量读取 |
| `utils/task/TaskOutput.ts` | ~320 | 输出缓冲 + 分页 + 流式读取 |
| `utils/task/sdkProgress.ts` | ~30 | SDK 事件发送 |

### 2.2 7 种任务类型

```typescript
// Task.ts
type TaskType = 'local_bash' | 'local_agent' | 'remote_agent'
              | 'in_process_teammate' | 'local_workflow'
              | 'monitor_mcp' | 'dream'
```

| 类型 | 对应场景 | 独占字段 |
|------|---------|---------|
| `local_bash` | 后台 bash 命令 | `command`, `result`(exitCode), `shellCommand`, `agentId` |
| `local_agent` | 本地异步 Agent | `agentId`, `prompt`, `progress`(token/tool计数), `result`, `messages` |
| `remote_agent` | 远程会话 Agent | `sessionId`, `reviewProgress`, `ultraplanPhase` |
| `in_process_teammate` | 多 Agent 队友 | `identity`, `awaitingPlanApproval`, `isIdle`, `shutdownRequested` |
| `local_workflow` | Workflow 脚本 | 通过 `WORKFLOW_SCRIPTS` 功能开关 |
| `monitor_mcp` | MCP 监控 | 通过 `MONITOR_TOOL` 功能开关 |
| `dream` | 异步排队任务 | `phase`(starting/updating), `sessionsReviewing` |

### 2.3 5 种状态

```typescript
// Task.ts
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'
```

```
pending ──→ running ──→ completed
                    ──→ failed
                    ──→ killed (显式停止)
```

`isTerminalTaskStatus()` — 终态 = `completed | failed | killed`，不可逆。

### 2.4 基类字段 (TaskStateBase)

```typescript
// Task.ts
{
  id: string              // 前缀+8位随机: "b3x7k2m9"
  type: TaskType          // 辨别联合的 key
  status: TaskStatus
  description: string     // 人类可读摘要
  toolUseId?: string      // 触发此任务的 tool_use ID
  startTime: number       // 创建时间戳 ms
  endTime?: number        // 终态时间戳
  totalPausedMs?: number  // 累计暂停时间
  outputFile: string      // 磁盘输出文件绝对路径
  outputOffset: number    // 增量读取的字节偏移
  notified: boolean       // 用户是否已被通知完成
}
```

### 2.5 运行时框架：`utils/task/framework.ts`

核心轮询循环（每秒一次）：

```
pollTasks()                     ← 每 1000ms 一次
  ├── generateTaskAttachments() ← 读所有运行中任务的新输出增量
  │     ├── getTaskOutputDelta() ← 基于 outputOffset 的增量读取
  │     └── 产生 task_status 附件
  ├── applyTaskOffsetsAndEvictions() ← 原子更新 offset + 驱逐终态任务
  └── enqueueTaskNotification() ← 终态任务 → 构造 XML 入队
```

关键常量：`POLL_INTERVAL_MS = 1000`, `STOPPED_DISPLAY_MS = ...`, `PANEL_GRACE_MS = ...`

---

## 3. Disk Todo 系统 —— 模型的便利贴

### 3.1 四个工具

| 工具 | 文件 | 参数 |
|------|------|------|
| `TaskCreate` | `tools/TaskCreateTool/TaskCreateTool.ts` | subject, description, activeForm?, metadata? |
| `TaskUpdate` | `tools/TaskUpdateTool/TaskUpdateTool.ts` | taskId, subject?, description?, activeForm?, status?, addBlocks?, addBlockedBy?, owner?, metadata? |
| `TaskList` | `tools/TaskListTool/TaskListTool.ts` | (无参数) |
| `TaskGet` | `tools/TaskGetTool/TaskGetTool.ts` | taskId |

TaskOutput 和 TaskStop 归属于 AppState 系统（始终可用，不受 `isTodoV2Enabled` 门控）。

### 3.2 数据模型 (`utils/tasks.ts` 第 77-88 行)

```typescript
{
  id: string              // 自增数字 ID（高水位线管理）
  subject: string          // 祈使句标题
  description: string      // 描述
  activeForm?: string      // 进行时态，显示在 spinner 中
  owner?: string           // 归属（蜂群模式下自动分配 Agent 名）
  status: 'pending' | 'in_progress' | 'completed'
  blocks: string[]         // 本任务阻塞哪些任务
  blockedBy: string[]      // 本任务被哪些任务阻塞
  metadata?: Record<string, unknown>
}
```

### 3.3 磁盘存储

```
~/.claude/tasks/
  └── {taskListId}/           ← 按会话/团队隔离
        ├── high_water_mark    ← 自增 ID 计数器
        ├── 1.json
        ├── 2.json
        ├── lock               ← 文件锁，防并写
```

### 3.4 依赖管理

`TaskUpdate` 的 `addBlockedBy`/`addBlocks` 通过 `blockTask()` 双向更新两个 JSON 文件：

```
TaskUpdate(taskId: "2", addBlockedBy: ["1"])
  → blockTask() 原子更新：
      task-1.json: { blocks: ["2"] }
      task-2.json: { blockedBy: ["1"] }
```

TaskList 返回时自动过滤已完成的 blockedBy 任务。

### 3.5 TaskUpdate 的特殊行为

- **owner 自动分配**：`status: 'in_progress'` 且无归属时，自动 `setOwner(getAgentName())`
- **metadata 合并**：shallow merge，`null` 值删除 key
- **验证提醒**：主线程 Agent 完成最后 3+ 任务且无 "verif" 关键词时，注入验证提醒
- **hooks**：TaskCreated 和 TaskCompleted hooks，可阻断操作
- **邮件箱通知**：owner 变更时（蜂群模式）发送消息到新 owner 的队友邮件箱

---

## 4. 反馈机制：三层结构

### 4.1 第一层：Spinner 实时文本

源码：`components/Spinner.tsx` 第 162-170 行

```typescript
const currentTodo = tasksV2?.find(task =>
  task.status !== 'pending' && task.status !== 'completed');
const message = currentTodo?.activeForm     // 优先
  ?? currentTodo?.subject                   // 回退
  ?? randomVerb;                            // 最后回退
```

模型调用 `TaskUpdate(activeForm: "正在重构认证模块...")` → `notifyTasksUpdated()` → `TasksV2Store` 刷新 → Spinner 实时显示。

### 4.2 第二层：TaskListV2 图标列表

源码：`components/TaskListV2.tsx`

| 状态 | 图标 | 样式 |
|------|------|------|
| completed | ✓ (figures.tick) | 绿色 + 删除线 + 暗色 |
| in_progress | ■ (figures.squareSmallFilled) | 品牌色 + 粗体 |
| pending | □ (figures.squareSmall) | 默认灰色 |
| blocked | ↳ (figures.pointerSmall) | 箭头 + "blocked by #N" |

扩展特性：30 秒内完成的任务优先显示，全部完成 5 秒后自动隐藏。宽终端(≥60列)显示 owner 名 + 主题色。

### 4.3 第三层：XML 通知注入

源码：`tasks/LocalAgentTask/LocalAgentTask.tsx` 第 197 行

```xml
<task-notification>
  <task-id>a3x7k2m9</task-id>
  <output-file>/path/to/output</output-file>
  <status>completed</status>
  <summary>Agent "Search UUID" finished</summary>
  <result>Found 100+ files referencing UUID...</result>
  <usage>total_tokens: 50000</usage>
</task-notification>
```

入队（`enqueuePendingNotification`, priority: `'later'`） → 下一轮 API 调用前通过 `getQueuedCommandAttachments()` 取出 → 转为 user-role 消息注入消息数组 → 模型在下一轮"读到"它。

**Priority: 'later'** 确保通知不阻塞用户输入（`messageQueueManager.ts` 第 143 行）。

### 4.4 文件监听与跨进程同步

源码：`hooks/useTasksV2.ts` (TasksV2Store)

```
fs.watch(tasksDir)
  → debounce(50ms)
  → listTasks()          ← 重读所有任务文件
  → 过滤 _internal 任务
  → 有未完成 → 显示 + 5s 轮询 fallback
  → 全部完成 → 5s 倒计时 → resetTaskList() → 清空文件 → 隐藏
```

---

## 5. 分阶段机制

### 5.1 Coordinator 模式的 4 阶段流水线

源码：`coordinator/coordinatorMode.ts` 第 111 行 `getCoordinatorSystemPrompt()`

| 阶段 | 执行者 | 并发 | 内容 |
|------|--------|------|------|
| Research | Workers | 并行 | 调查代码库、找文件、理解问题 |
| Synthesis | Coordinator | 串行 | 阅读发现、理解问题、编写实现规格 |
| Implementation | Workers | 按文件集串行 | 按规格做针对性修改 |
| Verification | Workers | 独立 | 验证修改可用 |

**关键规则**：Coordinator 模式强制作所有 Agent `run_in_background: true`。Worker 结果通过 `<task-notification>` XML 返回。

### 5.2 Disk Todo 的依赖驱阶段

```
TaskCreate(id:1, subject:"实现登录")
TaskCreate(id:2, subject:"写测试")
TaskUpdate(id:2, addBlockedBy: ["1"])  ← 2 依赖 1

模型看到 TaskList 结果：
  #1 [pending] 实现登录
  #2 [pending] 写测试 [blocked by #1]  ← 自动不可选
```

系统提示词指示模型按 ID 顺序优先处理（早期任务为后期任务设上下文）。

### 5.3 Workflow 脚本的阶段跟踪

```typescript
// Workflow meta 定义
export const meta = {
  phases: [
    { title: 'Scan', detail: 'grep test logs' },
    { title: 'Fix',  detail: 'one agent per flaky test' },
  ],
}
```

每个 `phase()` 调用对应一个阶段，SDK 事件中有 `workflow_progress: SdkWorkflowProgress[]` 字段。

---

## 6. 完整生命周期示例

```
模型规划：
  TaskCreate(id:1, subject:"实现登录", status:pending)
  TaskCreate(id:2, subject:"写测试",   status:pending, blockedBy:["1"])
  → 用户看到：2 个灰色方块任务

模型开始工作：
  TaskUpdate(id:1, status:in_progress, activeForm:"正在实现登录逻辑...")
  → Spinner 显示："正在实现登录逻辑..."
  → TaskListV2: ■ 实现登录 (品牌色方块 + 粗体)

派生子 Agent：
  Agent(subagent_type:"general-purpose", prompt:"...", run_in_background:true)
  → registerTask() → AppState.tasks["a3x7k"] = { status:running }
  → 后台任务药丸："1 local agent"
  → 模型收到：<system-reminder>Background agent is running...</system-reminder>

子 Agent 完成：
  → enqueueTaskNotification() → <task-notification> XML 入队
  → 下一轮 API：XML 以 user 消息注入 → 模型 "读到" 结果

任务完成：
  TaskUpdate(id:1, status:completed)
  → TaskListV2: ✓ 实现登录 (绿色 checkmark + 删除线)
  → 5 秒后自动消失

下一任务解锁：
  TaskUpdate(id:2, status:in_progress, activeForm:"正在写测试...")
  → Spinner 切换文本
```

---

## 7. 关键设计洞察

### 任务状态不嵌入 System Prompt

不走结构化注入，走 attachment 管道。好处：
- 不占固定 system prompt token 配额
- 事件驱动（只在变化时产生通知）
- 模型天然区分"用户输入"和"系统通知"（`<task-notification>` 标签）

### activeForm 的双面角色

唯一同时服务用户（Spinner 动画）和模型（提示词告知用途）的字段。模型通过它向用户实时汇报"正在做什么"。

### 通知优先级控制

```typescript
enqueuePendingNotification({ priority: 'later' })
```

`'later'` 优先级确保任务通知绝不抢占用户输入的位置，只在空闲时发送。

### 依赖管理的双向性

`blockTask()` 一次调用更新**两个**文件（task-A.blocks 和 task-B.blockedBy），保持一致性。

---

## 8. 涉及的核心源文件

| 路径 | 关键内容 |
|------|---------|
| `Task.ts:1-125` | TaskType、TaskStatus、TaskStateBase、Task 接口 |
| `tasks.ts:1-39` | getAllTasks()、getTaskByType() 注册表 |
| `tasks/types.ts` | TaskState 联合类型、isBackgroundTask() |
| `tasks/LocalShellTask/LocalShellTask.tsx` | Bash 后台进程实现 |
| `tasks/LocalAgentTask/LocalAgentTask.tsx` | 本地 Agent 实现 + 通知入队 |
| `tasks/RemoteAgentTask/RemoteAgentTask.tsx` | 远程 Agent 实现 |
| `tasks/InProcessTeammateTask/InProcessTeammateTask.tsx` | 队友 Agent 实现 |
| `utils/task/framework.ts` | pollTasks()、registerTask()、evictTerminalTask() |
| `utils/task/diskOutput.ts` | DiskTaskOutput、getTaskOutputDelta() |
| `utils/task/TaskOutput.ts` | TaskOutput 类、增量读取 |
| `utils/tasks.ts:77-88` | Disk Todo 数据模型、CRUD、blockTask() |
| `tools/TaskCreateTool/TaskCreateTool.ts` | 创建工具实现 |
| `tools/TaskUpdateTool/TaskUpdateTool.ts` | 更新工具实现（含 hooks、owner、验证提醒） |
| `tools/TaskListTool/TaskListTool.ts` | 列表工具实现 |
| `tools/TaskOutputTool/TaskOutputTool.tsx` | 输出读取工具 + UI |
| `tools/TaskStopTool/TaskStopTool.ts` | 停止工具 + stopTask() |
| `coordinator/coordinatorMode.ts` | 4 阶段 Workflow 系统提示词 |
| `components/Spinner.tsx:162-170` | activeForm 读取逻辑 |
| `components/TaskListV2.tsx` | 任务列表 UI 渲染 |
| `components/tasks/BackgroundTask.tsx` | 后台任务单行组件 |
| `components/tasks/BackgroundTaskStatus.tsx` | 状态栏药丸组件 |
| `hooks/useTasksV2.ts` | TasksV2Store 单例 + 文件监听 |
| `constants/xml.ts:28-34` | 任务通知 XML 标签常量 |
