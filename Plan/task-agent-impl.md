# Task + AgentTool 实现计划

> **时间**：2026-08-02 | **状态**：计划
> **目标**：最小化实现后台任务管理 + 子Agent创建

---

## 一、实现范围

| 模块 | Claude Code 原版 | my-coder 最小版 |
|------|-----------------|----------------|
| Task 系统 | 7种类型, 3,286行 | 2种(local_bash + local_agent), ~100行 |
| AgentTool | 20文件, 6,782行 | 1个工具 + 1个核心函数, ~200行 |
| **总计** | ~10,000行 | **~300行** |

---

## 二、Task 系统 — 最小实现

### 2.1 数据结构

```typescript
// 只保留我们需要的两种
type TaskType = 'local_bash' | 'local_agent';
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

interface TaskState {
  id: string;                    // 自动生成: "a" + 8位base36
  type: TaskType;
  status: TaskStatus;
  description: string;           // 人类可读的描述
  startTime: number;
  endTime?: number;
  output?: string;               // 完成后存储结果
}
```

### 2.2 Task 注册表

```typescript
// 简单的内存Map, 不需要持久化
const taskRegistry = new Map<string, TaskState>();

function createTask(type: TaskType, description: string): TaskState {
  const id = type[0] + randomBase36(8);  // "a" + "hk39x2v7"
  const task: TaskState = { id, type, status: 'pending', description, startTime: Date.now() };
  taskRegistry.set(id, task);
  return task;
}

function completeTask(id: string, output: string) {
  const task = taskRegistry.get(id);
  if (task) {
    task.status = 'completed';
    task.endTime = Date.now();
    task.output = output;
    // 10分钟后自动清理
    setTimeout(() => taskRegistry.delete(id), 600_000);
  }
}
```

### 2.3 使用场景

```
场景1: BashTool 后台命令
  - 命令超时或用户设 run_in_background
  - createTask('local_bash', 'npm test')
  - 主Agent返回 taskId, 继续响应用户
  - 命令完成 → completeTask(id, output)
  - 下一轮对话注入 system notification

场景2: AgentTool 后台子Agent
  - 主Agent调 spawnBackgroundAgent
  - createTask('local_agent', '修复 foo.ts 的bug')
  - 子Agent在后台跑
  - 完成 → completeTask(id, summary)
  - 通知主Agent
```

---

## 三、AgentTool — 最小实现

### 3.1 文件结构

```
tools-v2/AgentTool/
├── AgentTool.ts      ← buildTool 工厂, 暴露给 LLM
└── prompt.ts         ← 工具描述
```

### 3.2 AgentTool.ts

```typescript
const inputSchema = z.object({
  description: z.string().describe('Short (3-5 word) description'),
  prompt: z.string().describe('Task for the sub-agent to complete'),
  subagent_type: z.enum(['general-purpose','explore']).optional(),
  run_in_background: z.boolean().optional(),
});

export const AgentTool = buildTool({
  name: 'Agent',
  inputSchema,
  async description() { return 'Launch a sub-agent to handle complex tasks...'; },
  isReadOnly: () => false,

  async call({ description, prompt, subagent_type, run_in_background }) {
    // 1. 创建子Agent的messages (不继承主Agent)
    const subMessages = buildSubAgentContext(prompt);

    // 2. 如果是后台模式
    if (run_in_background) {
      const task = createTask('local_agent', description);
      // 在后台跑, 不await
      runSubAgent(subMessages, task.id).then(result => {
        completeTask(task.id, result);
        // 注入通知到主Agent上下文
        sessionMessages.push({
          role: 'user',
          content: `[${description} 完成]:\n${result.slice(0, 500)}`
        });
      });
      return { data: `Agent spawned: ${task.id}` };
    }

    // 3. 同步模式: 等子Agent跑完
    const result = await runSubAgent(subMessages);
    return { data: result };
  },
});
```

### 3.3 子Agent 核心循环 (runSubAgent)

```typescript
async function runSubAgent(
  messages: ChatMessage[],
  taskId?: string
): Promise<string> {
  const subPrompt = 'You are a sub-agent. Complete the task and return a concise report.';

  for (let i = 0; i < 10; i++) {  // 子Agent最多10轮
    const response = await callLLM(subPrompt, messages);

    if (response.stop_reason === 'end_turn') {
      const text = extractText(response);
      return text || '(sub-agent completed, no output)';
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = await executeToolCalls(response.content);
      messages.push({ role: 'user', content: toolResults });
    }
  }
  return '(sub-agent reached max iterations)';
}
```

### 3.4 上下文隔离 (buildSubAgentContext)

```typescript
function buildSubAgentContext(taskPrompt: string): ChatMessage[] {
  return [{
    role: 'user',
    content: `Complete this task and return a concise report of what was done:
${taskPrompt}`
  }];
}
```

子Agent 的 messages 从零开始——不继承主Agent 的对话历史。这是解决"角色混淆"的核心。

---

## 四、需要改动的现有文件

### main.ts — 新增2个函数 + 1个工具注册

```
+ runSubAgent()         ← 子Agent循环 (~60行)
+ buildSubAgentContext() ← 上下文隔离 (~10行)
+ AgentTool 加到 toolMap  ← 1行
+ AgentTool 加到 getAllTools() ← 1行
```

### tools-v2/index.ts — 注册 AgentTool

### tools-v2/AgentTool/ — 新建目录 (2文件, ~100行)

---

## 五、实施步骤

### Step 1: Task 系统 (~80行)
- 在 main.ts 加 taskStateMap + createTask() + completeTask()
- 不需要改 BashTool — 暂时不走后台

### Step 2: 子Agent引擎 (~80行)
- runSubAgent() + buildSubAgentContext()——独立messages + 10轮循环

### Step 3: AgentTool 工具 (~100行)
- 新建 tools-v2/AgentTool/
- Zod schema + buildTool + call()
- 支持同步模式 (等完返回)
- 后台模式可选 (加 run_in_background 参数)

### Step 4: 集成
- main.ts 注册 AgentTool
- 测试: "帮我 spawn 一个子Agent 去读 src/main.ts, 然后告诉我它有多少行"
