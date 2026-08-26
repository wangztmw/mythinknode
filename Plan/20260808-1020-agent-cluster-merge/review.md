# 审查报告

> 审查方式：2 个 Agent 并行——缺陷分析 + 模块协调性

---

## 高危问题（必须先修再执行）

### 1. BashTool 后台任务断裂
- **维度**: 缺陷 N1 + 协调 1 + 协调 6
- **描述**: `initBashBg` 需要 `createTask(type, subject, desc)` 回调。当前从 `agent_team.ts` 的 `addMember` 传入。删除 agent_team 后，BashTool 的 `run_in_background` 路径会崩溃。
- **修复**: 在 `AgentEngine` 上新增 `registerBashMember(subject, desc?): MemberState` 和 `completeBashMember(id, output)` 两个方法。Mythinknode.ts 的 `initBashBg` 直接传这两个方法。

### 2. SUB_AGENT_PROMPT 从未生效
- **维度**: 协调 2
- **描述**: `AgentTool` 传了 `systemPrompt: SUB_AGENT_PROMPT`，但 `AgentLoopParams` 没有 `systemPrompt` 字段，`agentLoop` 也不传给 `callLLM`。子 Agent 实际用的是主 Agent 的完整编排提示词。
- **修复**: `AgentLoopParams` 加 `systemPrompt?: string`，`agentLoop` 内传给 `callLLM` 的第 4 参数。

### 3. MemberState.type 删除导致 bash 任务误设 agentLoop
- **维度**: 缺陷 N2
- **描述**: 没有 `type` 字段后，Bash 后台任务也会被初始化 `agentLoop: { roundCount: 0, toolUseCount: 0 }`。
- **修复**: 保留 `type` 字段，仅在 `type === 'local_agent'` 时初始化 agentLoop。

---

## 中危问题（执行时同步修复）

### 4. 通知字符串残留 "AgentTeam"
- **维度**: 协调 3 + 缺陷 N4
- **描述**: cli.ts (line 145)、AgentTool.ts (line 100, 120) 的通知文本含 `AgentTeam(check, ...)`。合并后应改为 `Agent(action='check', taskId='...')`。

### 5. 系统提示词需完整重写
- **维度**: 协调 4 + 缺陷 N5
- **描述**: `buildSystemPrompt()` 中有 7 处 `AgentTeam` 引用，需改写为 `Agent(action='xxx')` 格式。`group` 参数删除后编排指令也需调整。

### 6. AgentTool prompt.ts 需覆盖 5 个 action
- **维度**: 协调 8
- **描述**: 当前 DESCRIPTION 只描述 spawn。合并后需覆盖 check/wait_any/direct/kill。

---

## 低危问题（可延后）

### 7. `Agent(check)` 输出截断
- **维度**: 缺陷 P1 + 协调 9
- **描述**: 磁盘读写删除后，check 只能读内存中的 `member.output`（当前截断 500 字符）。应保留完整文本在内存中。

### 8-12. 其他低危项
- preRoundCheck 参数签名不匹配（协调 5）
- agent_def.ts import 删除时序（协调 10）
- cli.ts 中 `as any` 残留（协调 11）
- 已移除 action 的 zod 错误提示（缺陷 N7）
