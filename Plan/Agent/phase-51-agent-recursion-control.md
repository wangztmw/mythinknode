# Phase 51：子 Agent 递归控制 + TaskTool 权限边界

> **创建时间**：2026-08-03
> **状态**：规划中
> **严重程度**：🔴 致命
> **涉及文件**：`src/agent.ts`、`src/tools-v2/AgentTool/AgentTool.ts`、`src/tools-v2/TaskTool/TaskTool.ts`、`src/task.ts`

---

## 一、问题陈述

### P0-a：子 Agent 可无限递归创建子 Agent

当前子 Agent 的 `runSubAgent()` 调用 `this.callLLM(messages)`，传入的 systemPrompt 和主 Agent **完全一样**（agent.ts `buildSystemPrompt()` 只生成一次，所有调用共享）。这套 prompt 包含 Agent 工具的使用规则：

```
- Agent: description=标题, prompt=指令, background=true批量并行。子Agent英文执行，用中文汇报
```

这意味着子 Agent 可以无差别调用 Agent 工具，创建孙子 Agent。孙子 Agent 拥有完全相同的 systemPrompt，又可以创建曾孙 Agent……无限递归。

**触发路径**：
```
主 Agent: Agent(background=true, "调研A") ×3
  └── 子Agent-1: Agent(background=true, "子调研X") ×3
  │     └── 孙Agent-X1: Agent(background=true, ...) → 指数扩散
  └── 子Agent-2: Agent(background=true, "子调研Y") ×2...
```

**无任何限制**：
- 子 Agent 可用工具集 = 全部 12 个工具（含 Agent）
- 递归深度无上限
- `run_in_background: true` 下父 Agent 不等待子 Agent 完成

**后果**：API 费用失控 + 速率限制触发 + taskRegistry 撑爆。

### 横向隔离缺失

子 Agent 仍然有 TaskTool，共享 taskRegistry。这意味着：
- 子 Agent 可以 `Task(list)` 看到所有任务（包括其他并行子 Agent）
- 子 Agent 可以 `Task(kill)` 杀死任何任务（包括其他并行子 Agent）
- 子 Agent 可以 `Task(direct)` 给平行子 Agent 发指令

如果子 Agent-A 因为幻觉执行 `Task(kill, agentB)`，会直接破坏主 Agent 的编排计划。

---

## 二、修复方案：三层约束 + 一层权限

### 约束一：子 Agent 用受限工具集（代码层，核心防线）

**改动文件**：`src/agent.ts` `runSubAgent()` + `callLLM()` 方法

```typescript
// 子 Agent 禁止使用的工具
const SUB_AGENT_BLOCKED_TOOLS = new Set(['Agent']);

// callLLM 新增参数
private async callLLM(
  messages: ChatMessage[],
  label?: string,
  onProgress?: (e: ProgressEvent) => void,
  toolsOverride?: Tools,  // ← 新增
): Promise<...> {
  const effectiveTools = toolsOverride || this.tools;
  const formattedTools = this.provider.formatTools(effectiveTools);
  // ... 其余不变
}

// runSubAgent 内部，构建受限工具集传入
async runSubAgent(taskPrompt: string, agentId: string): Promise<string> {
  const subAgentTools = this.tools.filter(
    t => !SUB_AGENT_BLOCKED_TOOLS.has(t.name)
  );
  // callLLM 时传入 subAgentTools
  const response = await this.callLLM(messages, undefined, undefined, subAgentTools);
}
```

**影响**：改动 ~8 行。不影响主 Agent。

### 约束二：递归深度上限（架构层，兜底防线）

**改动文件**：`src/task.ts` `TaskState`

```typescript
export interface TaskState {
  // ... 现有字段
  depth: number;      // 0 = 主 Agent 直创, 1 = 子 Agent 创建, 2+ = 禁止
  parentId: string | null;  // 创建者的 taskId，null = 主 Agent 直接创建
}
```

AgentTool 创建任务时检查深度：

```typescript
const MAX_AGENT_DEPTH = 1;

// 获取当前 Agent 自身的 depth（如果是主 Agent 调用的，depth 为 -1 表示"无父任务"）
const parentDepth = (currentAgentTask?.depth ?? -1);
const depth = parentDepth + 1;
if (depth > MAX_AGENT_DEPTH) {
  return { data: `BLOCKED: Maximum agent nesting depth (${MAX_AGENT_DEPTH}) exceeded. You are at depth ${depth}. Sub-agents cannot spawn further sub-agents.` };
}
```

**关键逻辑**：主 Agent 自身不在 taskRegistry 中，所以 `parentDepth` = -1，计算结果 depth = 0。子 Agent 在 taskRegistry 中（depth=0），创建孙子时 depth = 1 > 0 → 拦截。

### 约束三：子 Agent 专用 systemPrompt（提示层，模型防线）

**改动文件**：`src/agent.ts` `buildSystemPrompt()` 或 `callLLM()` 内

```typescript
const SUB_AGENT_SYSTEM_SUFFIX = `\n\n## YOUR IDENTITY
You are a SUB-AGENT operating inside a parent agent session.
- You CANNOT spawn sub-agents. You are a sub-agent yourself.
- Complete ONLY the assigned task. Return a concise report. Do not ask questions.`;

// callLLM 内部，if toolsOverride 则追加上下文
const effectiveSystemPrompt = toolsOverride
  ? this.systemPrompt + SUB_AGENT_SYSTEM_SUFFIX
  : this.systemPrompt;
```

**三重防线关系**：工具集（代码）→ 深度上限（架构）→ Prompt（模型）。各守一层，即使工具名变更绕过了约束一，深度上限仍然拦截。

### TaskTool 权限边界

**改动文件**：`src/tools-v2/TaskTool/TaskTool.ts`

利用新增的 `parentId` 字段实现权限过滤：

```typescript
// 当前 Agent 的 taskId（由 AgentTool 在创建时注入到上下文中）
// 子 Agent 的 systemPrompt 中告知其自身 ID

// TaskTool list 过滤：
const myId = thisAgentId; // 从上下文获取
const visibleTasks = tasks.filter(t =>
  t.parentId === null     // 主 Agent 直创的任务（全局可见）
  || t.parentId === myId  // 我自己的子任务
  || t.id === myId        // 我自己
);

// TaskTool kill 权限：
if (taskId !== myId && targetTask.parentId !== myId) {
  return { data: `Cannot kill task ${taskId}: not your child task.` };
}

// TaskTool direct 权限：
if (taskId !== myId && targetTask.parentId !== myId) {
  return { data: `Cannot direct task ${taskId}: not your child task.` };
}
```

> **设计权衡**：也可以简单地把 TaskTool 也加入 `SUB_AGENT_BLOCKED_TOOLS`。但子 Agent 确实需要 Task(wait) 来等待它自己创建的 Bash 后台任务。所以不是砍掉，而是加权限边界。

---

## 三、需要传递给子 Agent 的新字段

为了让子 Agent 知道"我是谁"和"我有哪些子任务"，需要在 context 中注入：

```typescript
// runSubAgent 或 buildSubAgentContext 中：
{
  agentId: "l3kf8m2x",     // 我的 taskId
  depth: 0,                // 我的深度
  parentId: null,          // 我的父任务（null=主Agent直创）
}
```

这些信息在子 Agent 的 systemPrompt 中可见，TaskTool 通过它们判断权限。

---

## 四、改动清单

| 文件 | 改动 | 预计行数 |
|------|------|---------|
| `src/agent.ts` | callLLM 加 toolsOverride 参数；runSubAgent 构建受限工具集并传入；子 Agent systemPrompt 追加身份声明 | +15/-2 |
| `src/tools-v2/AgentTool/AgentTool.ts` | 调用 createTask 替代手动构造；传入 depth/parentId 计算 | +8/-10 |
| `src/tools-v2/TaskTool/TaskTool.ts` | list/check/kill/direct 加入权限过滤逻辑 | +20/-3 |
| `src/task.ts` | TaskState 新增 depth、parentId 字段；createTask 接受 parentId 参数 | +6 |

---

## 五、验证标准

| # | 场景 | 期望结果 |
|---|------|---------|
| 1 | 子 Agent 尝试调用 Agent 工具 | 工具列表中无 Agent，LLM 不知道有这个工具 |
| 2 | depth=0 的子 Agent 尝试创建子 Agent | 工具列表无 Agent → 走不到 depth 检查（约束一先拦截） |
| 3 | 如果约束一被绕过，depth=1 时创建 | BLOCKED: Maximum agent nesting depth exceeded |
| 4 | 子 Agent Task(list) | 只看得到自己 + 自己创建的 + 主 Agent 直创的任务，看不到兄弟 Agent |
| 5 | 子 Agent Task(kill) 杀兄弟 Agent | Cannot kill task: not your child |
| 6 | 子 Agent Task(wait) 等自己的 Bash 任务 | 正常工作 |
| 7 | 主 Agent 一切行为不变 | Agent 工具正常、TaskTool 无权限限制 |
