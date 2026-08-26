# 执行步骤（审查修订版）

> 基于 review-coordination.md 修订。原 Layer 3 移到 Layer 10 之后，Layer 4 拆为 4a+4b，新增 prompt.ts 清理。

---

## Layer 1: cli.ts — 删 isMainAgent

**文件**: `src/cli/cli.ts`

**改动**: 找到 `true, // isMainAgent` 传参，改为 `false`
- 效果: session_loop Phase 7 块短路（`if (params.isMainAgent ...)` 永远 false）

**验证**: `npx tsc --noEmit`

---

## Layer 2: session_loop.ts — 删 Phase 7 + 树参数 + 内联 LoopResult

**文件**: `src/session_loop.ts`

**改动**:
1. 删 Phase 7 thinkWorkTree 注入块（~20行，`if (params.isMainAgent ...)` 整块）
2. 删参数: `isMainAgent`, `agentMeta`, `fileTracker`
3. 从 `task_tree/types.ts` 内联 `LoopResult` 类型定义到本文件
4. 确认 `agentLoop` 返回值类型 `Promise<LoopResult>` 改为引用本地定义

**验证**: `npx tsc --noEmit`

---

## Layer 3 (原 4a): AgentTool.ts — 删 syncTreeNode + prompt.ts

**文件**: `src/tools-v2/agent/AgentTool/AgentTool.ts`
**文件**: `src/tools-v2/agent/AgentTool/prompt.ts`

**AgentTool.ts 改动**:
1. 删 `syncTreeNode` 函数（整个函数体，~87行）
2. 删所有 task_tree import 行（lock, types, paths, core, persist, cascade, validate, file_tracker 等）
3. 删 `context_files` 参数定义
4. 删 `parent_node_id` 参数定义

**prompt.ts 改动**:
1. 删第 3 行: `If you created a tree node with TreeCmd(add_child), pass the returned nodeId as parent_node_id...`

**验证**: `npx tsc --noEmit`

---

## Layer 4 (原 4b): AgentTool.ts — 删 execute() 内 6 处树代码

**文件**: `src/tools-v2/agent/AgentTool/AgentTool.ts`

**逐块删除**:

| # | 行号范围 | 代码块 | 操作 |
|---|---------|--------|------|
| 1 | ~107-130 | `addChildNode` — parent_node_id 传入时自动建树节点 | 删除整块 |
| 2 | ~136-160 | `context_files` 冲突检测 + `acquireFileLock` | 删 acquireFileLock，**保留** contextFiles 内存比较（Agent间冲突检测，不依赖task_tree） |
| 3 | ~188-197 | `isAncestorAlive` 同步模式前检查 | 删除整块 |
| 4 | ~228-240 | `dispatchNode` (background 启动时) | 删除整块 |
| 5 | ~267-280 | `dispatchNode` (sync 完成后) | 删除整块 |
| 6 | 253,260,292,299 | `releaseFileLocks` 调用 ×4 | 删除每处调用 |

**验证**: `npx tsc --noEmit`

---

## Layer 5: agent_team.ts — 删树感知字段 + 内联 agentOutputPath

**文件**: `src/tools-v2/agent/AgentTeam/agent_team.ts`

**改动**:
1. 删字段: `treeNodeId?: string`, `treeRole?: 'planner'|'supervisor'|'worker'`
   - **保留** `contextFiles?: string[]`（纯内存声明，用于 Agent 间文件冲突检测）
2. 从 `task_tree/paths.ts` 内联 `agentDir`/`agentOutputPath` 函数到本文件
3. 删 task_tree import

**验证**: `npx tsc --noEmit`

---

## Layer 6: Mycoder.ts — 删树初始化 + 修正 saveSession

**文件**: `src/Mycoder.ts`

**改动**:
1. 删 `import { cleanOldSessions } from './task_tree/persist.js'`（persist.ts 已缺失）
2. 删 `cleanOldSessions()` 调用及其 try/catch 守卫
3. 删 `const { setMemberGetter } = await import('./task_tree/validate.js')`（validate.ts 已缺失）
4. 删 `const { resumeSessionOrchestrator } = await import('./task_tree/resume.js')`（resume.ts 已缺失）
5. 删整个 resume 逻辑块（try/catch 守卫的树恢复代码）
6. 删 `engine.setActiveTree(oldTreeId)` 调用
7. 删 `session.treeId` 读取
8. 修正 `saveSession` 调用: 去掉 `engine.activeTreeId || undefined` 参数

**验证**: `npx tsc --noEmit`

---

## Layer 7: session.ts — 删 treeId + 内联路径函数

**文件**: `src/session.ts`

**改动**:
1. 删 `treeId?: string` 字段及注释
2. 从 `task_tree/paths.ts` 内联 `sessionPath`/`sessionDir`/`SESSIONS_DIR` 常量
3. 删 `saveSession` 的 `treeId` 参数
4. 删 task_tree import

**验证**: `npx tsc --noEmit`

---

## Layer 8: tools-v2/core/index.ts — 删 TreeCmdTool import

**文件**: `src/tools-v2/core/index.ts`

**改动**:
1. 删第 14 行: `import { TreeCmdTool } from '../task_tree/TreeCmdTool/TreeCmdTool.js'`
2. 删工具注册行（约第 30 行）
3. 工具总数 14→13

**注意**: TreeCmdTool.ts 源文件已不存在，此处仅清理断裂 import。

**验证**: `npx tsc --noEmit`

---

## Layer 9: 物理删除 task_tree/ + thinker.ts

**操作**:
```bash
rm -rf src/task_tree/
rm -rf src/tools-v2/task_tree/
rm src/work_tree/thinker.ts
```

**被删除的文件**:
- `src/task_tree/types.ts` (221行)
- `src/task_tree/lock.ts` (169行)
- `src/task_tree/paths.ts` (47行)
- `src/task_tree/wal.ts` (372行)
- `src/task_tree/file_tracker.ts` (315行)
- `src/work_tree/thinker.ts` (104行)

**验证**: `npx tsc --noEmit`

---

## Layer 10: agent_def.ts — 删树感知代码 + worktree role

**文件**: `src/agent_def.ts`

**改动**:
1. 删字段: `activeTreeId`, `activeTreeNodeId`
2. 删方法: `setActiveTree()`, `getTreeContext()`
3. 删 `buildSystemPrompt` 签名中的 `'worktree'` role 类型
4. 删 worktree role 的专用 prompt 块（~15行）
5. 删 task_tree import（如果有）

**验证**: `npx tsc --noEmit`

---

## Layer 11: agent_def.ts — 重写 prompt

**文件**: `src/agent_def.ts`

**需删除/改写的行**（审查已精确定位）:

| 行号 | 原内容 | 操作 |
|------|--------|------|
| 165 | `TreeCmd(create) 建工作树→add_child 拆义群` | 改为"复杂任务→按内容领域并行派 Agent" |
| 166 | `[WORKTREE] 前缀的任务树` 提示 | 删除 |
| 185 | `TreeCmd: create/add_child/...` 工具列表项 | 删除 |
| 199 | `isLeaf=false，用 TreeCmd(add_child)` | 删除 |
| 206 | Planner prompt 中 `TreeCmd(create) 建树` | 改为"按内容领域分解，每领域一个 Agent" |
| 210 | `你是唯一的树写入者` | 删除 |
| 211 | `TreeCmd status 看全貌` | 改为"AgentTeam(wait/check) 看进度" |
| 221 | `parent_node_id——这是你唯一的树扩展方式` | 删除 |

**新增指引**:
- "复杂任务→按内容领域并行派发 Agent(background=true)"
- "每个 Agent 负责一个完整内容领域，自主搜、自主写"
- "AgentTeam(wait) 等待全部完成 → AgentTeam(check) 读结果 → 汇总交付"
- "你只做编排和汇总，不亲自执行基础搜索/写文件"

**验证**: `npx tsc --noEmit`

---

## Layer 12: dist 清理 + 编译 + 测试

**AgentTeamTool.ts 残留清理**:
- 文件: `src/tools-v2/agent/AgentTeam/AgentTeamTool.ts`
- 行 ~104: `(no tree associated with this task)` → 改为 `(tree feature removed — use AgentTeam(check) for agent result details)`

**dist 清理**:
```bash
rm -rf dist/task_tree/
rm -rf dist/tools-v2/task_tree/
rm -f dist/work_tree/thinker.js
```

**编译**: `npx tsc --noEmit`（确认零错误）

**手动测试**:
1. 启动 mycoder，输入简单问候 — 确认不再触发 thinker
2. 输入"帮我查一下今天AI领域有什么新闻" — 确认 Agent 派发正常
3. 输入复杂任务 — 确认主 Agent 按内容领域派 Agent（而非自己 curl）

---

## 监督方案

- 每层完成后 `npx tsc --noEmit` 验证
- 每层一个 git commit（方便回退到任意层）
- 全部完成后手动运行 mycoder 验证基本功能

## 回退

`git reset --hard HEAD~12` 回到初始状态
