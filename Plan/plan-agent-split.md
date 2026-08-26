# 重构：agent.ts 拆分 + team.ts → agent_team.ts + TaskTool → AgentTeamTool

> **创建时间**：2026-08-04
> **目标**：agent.ts 352行拆成定义+循环；team.ts 改名 agent_team.ts；TaskTool 改名 AgentTeamTool

---

## 一、agent.ts 拆分方案

### 1.1 `agent_def.ts`（~200行）

保留：类型定义 + 工具函数 + 类定义 + 构造函数 + system prompt + callLLM + notify + mergeToolCalls + onTurnComplete

导出：`AgentEngine`, `ProgressEvent`, `AgentResult`, `ToolCall`, `MergedTool`, `briefResult`

```typescript
// agent_def.ts
export interface ToolCall { ... }
export interface MergedTool { ... }
export type ProgressEvent = ...;
export interface AgentResult { ... }
export function briefResult(...) { ... }
export class AgentEngine {
  constructor(...) { ... }
  buildSystemPrompt() { ... }
  private async callLLM(...) { ... }
  flushNotifications() { ... }
  private mergeToolCalls(...) { ... }
}
```

### 1.2 `session_loop.ts`（~160行）

保留：run() + runSubAgent()

导入：`import { AgentEngine } from './agent_def.js'`
导出：无——直接给 AgentEngine.prototype 加方法

```typescript
// session_loop.ts
import { AgentEngine } from './agent_def.js';

AgentEngine.prototype.run = async function(userInput, onProgress) {
  // ... 25轮主循环
};

AgentEngine.prototype.runSubAgent = async function(taskPrompt, agentId) {
  // ... 10轮子Agent循环
};
```

### 1.3 文件变更

| 文件 | 改动 |
|------|------|
| `src/agent.ts` → 删除 | 分拆后不再需要 |
| `src/agent_def.ts` | 新建，~200行 |
| `src/session_loop.ts` | 新建，~160行 |
| `src/Mycoder.ts` | import 路径: `./agent.js` → `./agent_def.js` + `./session_loop.js` |
| `src/cli/cli.ts` | import 路径同上 |

---

## 二、team.ts → agent_team.ts

纯改名，在 Plan/plan-rename-task.md 基础上追加。

| 旧 | 新 |
|----|----|
| `src/team.ts` | `src/agent_team.ts` |
| 导入路径 | `./team.js` → `./agent_team.js` |

受影响文件：
- `src/Mycoder.ts`
- `src/agent_def.ts`（原 agent.ts）
- `src/tools-v2/AgentTool/AgentTool.ts`
- `src/tools-v2/TaskTool/TaskTool.ts`

---

## 三、TaskTool → AgentTeamTool

| 旧 | 新 |
|----|----|
| `src/tools-v2/TaskTool/` | `src/tools-v2/AgentTeamTool/` |
| `TaskTool.ts` | `AgentTeamTool.ts` |
| 工具名 | `Task` → `AgentTeam`（LLM 看到的工具名也改） |
| prompt 描述 | "Manage tasks" → "Manage agent team members" |

受影响文件：
- `src/tools-v2/index.ts`（工具注册）
- `src/Mycoder.ts`（初始化调用）
- `src/agent_def.ts`（system prompt 中的 Task 工具说明）

---

## 四、实施顺序

1. `agent.ts` 拆分 → `agent_def.ts` + `session_loop.ts`，编译验证
2. `team.ts` → `agent_team.ts` 改名，编译验证
3. `TaskTool` → `AgentTeamTool` 改名 + 工具名更新，编译验证
4. 全量烟火测试

## 五、验证清单

- [ ] `tsc` 零错误
- [ ] `echo "/exit" | node dist/Mycoder.js` 正常启动退出
- [ ] `echo "/help" | node dist/Mycoder.js` 工具列表正确（含 AgentTeam）
- [ ] import 无循环引用
- [ ] agent.ts 确认已删除
