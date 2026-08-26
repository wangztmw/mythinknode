# 锦上添花 — 断连信号修复计划

> **代号**：锦上添花
> **目标**：连接所有"写了没接"的接口和"接了没用"的信号
> **范围**：9 断开 + 7 部分 = 16 项

---

## 一、修复分组

### 组 A：角色分层激活（3 项）

| # | 项 | 修复 |
|---|-----|------|
| A1 | `_rolePrompt` 死代码 | AgentTool 创建子 Agent 时，根据 childDepth 调用 `buildSystemPrompt(role)` 替换 systemPrompt |
| A2 | `subagent_type` 缺角色 | 枚举加 `'planner'`/`'supervisor'`/`'worker'` |
| A3 | `agentMeta` 未读取 | agentLoop 内部根据 agentMeta 控制行为（或不消费则删掉参数） |

### 组 B：安全/校验链路（4 项）

| # | 项 | 修复 |
|---|-----|------|
| B1 | `validateDecomposition` 未调用 | TreeCmdTool create/add_child 前校验 |
| B2 | `decomposeWithValidation` 未调用 | 同 B1，LLM 分解后走校验→修正→fallback |
| B3 | `detectSecurityAnomaly` 未调用 | B1 的 validateDecomposition 后调 |
| B4 | `repairStaleReferences` 未调用 | resume.ts 的 detectLostAgents 后调 |

### 组 C：级联/感知（2 项）

| # | 项 | 修复 |
|---|-----|------|
| C1 | `isAncestorAlive` 未调用 | AgentTool preRoundCheck 中检查祖先存活 |
| C2 | `collectOrphanedResults` 未调用 | AgentTeamTool kill 中 cascadeKillTreeNode 前收集 |

### 组 D：写保护完善（3 项）

| # | 项 | 修复 |
|---|-----|------|
| D1 | `appendWal` TreeCmdTool 侧缺失 | TreeCmdTool 的 create/add_child/report/replace 写操作后调 appendWal |
| D2 | `TreeWriteLock` AgentTool 侧缺失 | AgentTool 写树时包锁 |
| D3 | `fileLocks` 不持久化 | saveSession 入写入 fileLocks 快照，resume 恢复 |

### 组 E：参数清理（4 项）

| # | 项 | 修复 |
|---|-----|------|
| E1 | `treeNodeId` 未消费 | agentLoop 中不消费就删掉 AgentLoopParams 中的字段 |
| E2 | `fileTracker` 传 undefined | AgentTool 传 `createFileTrackerHook(task.id, task.treeNodeId)` |
| E3 | `onComplete` 双重写入 | 去重：agentLoop 内部不调 onComplete，统一由调用方在返回后处理 |
| E4 | `blocked` 硬 break 不可达 | AgentTool preRoundCheck 增加 blocked 信号返回 |

---

## 二、执行监督

### Agent 布局

```
监工 Agent（编译 + 全量 grep 验证）
  ├─ Worker A: 组 A 角色分层（agent_def + AgentTool）
  ├─ Worker B: 组 B 安全校验（TreeCmdTool + resume）
  ├─ Worker C: 组 C 级联感知（AgentTool preRoundCheck + AgentTeamTool）
  ├─ Worker D: 组 D 写保护（TreeCmdTool appendWal + AgentTool lock + session fileLocks）
  └─ Worker E: 组 E 参数清理（session_loop + AgentTool fileTracker + onComplete 去重）
```

5 Worker 并行。每组改动独立，互不冲突。

### 验收

| # | 验证项 |
|---|--------|
| 1 | `npx tsc --noEmit` 零错误 |
| 2 | grep 确认 `_rolePrompt` 有外部调用点 |
| 3 | TreeCmdTool create/add_child 后调了 appendWal |
| 4 | AgentTool 写树操作前调了 TreeWriteLock.batch |
| 5 | AgentTool preRoundCheck 调了 isAncestorAlive |
| 6 | AgentTeamTool kill 调了 collectOrphanedResults |
| 7 | resume.ts 调了 repairStaleReferences |
| 8 | agentLoop 的参数中已无 treeNodeId（或已消费） |

### 代码量估算

| 组 | 改动文件 | 行数 |
|----|---------|------|
| A | agent_def.ts, AgentTool.ts | ~20 |
| B | TreeCmdTool.ts, resume.ts | ~25 |
| C | AgentTool.ts, AgentTeamTool.ts | ~15 |
| D | TreeCmdTool.ts, AgentTool.ts, session.ts | ~20 |
| E | session_loop.ts, AgentTool.ts | ~15 |
| **合计** | | **~95 行** |
