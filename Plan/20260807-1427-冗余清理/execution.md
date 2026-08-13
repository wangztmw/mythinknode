# 执行步骤

## 1. agent_team.ts — 删 5 项
- 删 MemberState 中 `depth`, `outputOffset`, `toolUseId` 字段
- 删 `addMember` 中 `outputOffset: 0`, `depth: 0` 赋值
- 删 `completeMember` 中 `m.outputOffset = output.length`
- 删 `appendMemberOutput` 函数（8行）
- 删 `cleanOldMembers` 空函数

## 2. Mycoder.ts — 删 cleanOldMembers
- import 中去掉 `cleanOldMembers`
- 删 `cleanOldMembers()` 调用行

## 3. agent_def.ts + session_loop.ts — 删 AgentResult
- `agent_def.ts`: 删 `export interface AgentResult { text, ms }`
- `session_loop.ts`: import 中去掉 `AgentResult`

## 4. AgentTool.ts — 删 subagent_type
- inputSchema 中去掉 `subagent_type` 字段
- call 解构中去掉 `subagent_type: _type`

## 5. session.ts — 删 listSessions
- 删 `export function listSessions()` (11行)

## 验证
- `npx tsc --noEmit` 零错误
- 确认 Mycoder.ts/AgentTool.ts/session_loop.ts 无残留引用
