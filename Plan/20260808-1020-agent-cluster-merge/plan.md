# 重组方案

## 文件变化

| 之前 | 之后 |
|------|------|
| `agent_team.ts` (102行) | **删除** |
| `AgentTeamTool.ts` + `prompt.ts` (237行) | **删除** |
| `AgentTool.ts` (152行) | **重写** ~220行 — spawn + 4 管理 action |
| `agent_def.ts` (230行) | **微改** — 加 MemberState 类型 + team Map 初始化，删构造函数 deps |
| `cli.ts` | **微改** — post-loop guard 用 `engine.team` |
| `Mythinknode.ts` | **微改** — 删 initAgentTool/initTaskTool 冗余注入 |
| `core/index.ts` | **微改** — 删 AgentTeamTool 注册 |

## 新 AgentTool

一个工具，5 个 action：

```
Agent({ action: 'spawn', description, prompt, background? })
Agent({ action: 'check', taskId })
Agent({ action: 'wait_any', timeout_ms? })
Agent({ action: 'direct', taskId, instruction })
Agent({ action: 'kill', taskId })
```

### 删掉的

| 删除项 | 原因 |
|--------|------|
| `context_files` 参数 + 冲突检测 | LLM 从不传此参数，死代码 |
| `group` 参数 + group_* action | 从未被 LLM 真正使用 |
| `inbox` action | 被信号通知替代 |
| `wait`（等全部）action | 被 wait_any 替代 |
| `list` action | 调试用，非核心路径 |
| `outputFile` + 磁盘读写 | 无持久化需求 |

### 保留的

| 保留项 | 原因 |
|--------|------|
| `wait_any` | 核心协调：任意完成即返回 |
| `check` | 按需读取报告，配合信号模式 |
| `direct` | 点对点调控 blocked Agent |
| `kill` | 偶尔需要终止跑偏的 Agent |
| 信号模式通知 | 不灌原文，只发一行信号 |
| MemberState.agentLoop | 追踪子 Agent 进度 |
| MemberState.feedback + BLOCKED 自动推送 | 子 Agent 自报阻塞 |

## 状态表（内聚到 AgentEngine）

```typescript
// agent_def.ts — AgentEngine 内
interface MemberState {
  id: string;
  status: 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'killed';
  subject: string;
  startTime: number;
  endTime?: number;
  output?: string;
  notified: boolean;
  feedback?: string;
  abortController?: AbortController;
  agentLoop?: { roundCount: number; toolUseCount: number; lastActivity?: string; lastOutput?: string };
  pendingInstruction?: string;
}

class AgentEngine {
  team: Map<string, MemberState> = new Map();
  // ...
}
```

## 引用链简化

```
之前:
  Mythinknode → agent_team (getTeam) → AgentEngine.constructor(deps)
  Mythinknode → initAgentTool({ taskRegistry, engine, notify })
  Mythinknode → initTaskTool({ taskRegistry, notify, pendingNotifications })
  AgentTool → _tasks (module static) → team Map
  AgentTeamTool → _tasks (module static) → same Map
  AgentEngine → this.team (instance prop) → same Map

之后:
  AgentEngine → this.team (instance prop) → 唯一持有者
  AgentTool → engine.team (通过 initAgentTool 注入)
  cli.ts → engine.team (直接访问)
```
