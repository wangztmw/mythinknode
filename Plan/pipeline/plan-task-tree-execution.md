# 任务树系统 — 执行计划

> **原则**：每个 Phase 独立可验证，完成后不回头。Phase 间串行，Phase 内并行。
> **度量**：用任务量（文件数 + 函数数）和监工验证数衡量。Agent 执行，不论天。
> **监工**：每个 Phase 结束有验证 Agent 专门检查——编译通过 + 类型正确 + 逻辑完整性。

---

## 总览

| Phase | 新建文件 | 修改文件 | 函数/接口 | 监工验证 |
|-------|---------|---------|----------|---------|
| 0 类型地基 | 1 | 0 | 14 类型 | 2 项 |
| 1 核心引擎 | 5 | 0 | 25 函数 | 7 项 |
| 2 LoopResult 单向门 | 0 | 4 | 3 函数 + 4 字段 | 7 项 |
| 3 工具集成 | 2 | 3 | 10 函数 + 6 action | 8 项 |
| 4 校验恢复 | 4 | 2 | 18 函数 | 6 项 |
| 5 提示词打磨 | 0 | 1 | 3 函数变体 | 9 项 |
| **合计** | **12** | **10** | **~76** | **39** |

---

## Phase 0：类型与接口地基

> 1 新建文件 · 14 类型定义 · 2 项验证 · 零逻辑

### 目标
定义所有共享类型，零逻辑。编译通过即成功。

### 产出
```
src/task_tree/types.ts    (~130行)  所有类型 + ITreeAgentBridge 接口
```

### 内容清单
- [ ] `TreeNode` 接口（id, parentId, meaning, context, task, role, status, assignedAgentId, depth, maxRounds, tools, result, replanCount, children, touchedFiles）
- [ ] `TaskTree` 接口（sessionId, rootId, nodes, createdAt, updatedAt, version）
- [ ] `MeaningGroup` 接口（meaning, context, subGroups?, isLeaf）
- [ ] `TaskDecomposition` 接口（purpose, parallelism, groups）
- [ ] `LoopStatus` 类型（'success' | 'max_rounds' | 'killed' | 'blocked' | 'crashed'）
- [ ] `LoopResult` 接口（status, text, blockedReason?）
- [ ] `ITreeAgentBridge` 接口（getMember, completeMember, onTreeNodeSynced）
- [ ] `WalEntry` 接口（seq, ts, sessionId, nodeId, event, payload）
- [ ] `TreeDelta` 接口（sessionId, version, nodeUpdates, nodeDeletions）
- [ ] `FileOperation` 接口（nodeId, agentId, toolName, filePath, operation, timestamp）
- [ ] `DecompositionQualityReport` 接口（passed, overDecomposed, inconsistent, warnings）
- [ ] `ReferenceCheck` 接口（valid, stale, orphaned）
- [ ] `ResumeResult` 接口（resumedMessages, resumedTree, lostAgentsRecovered, summary）
- [ ] `AgentMeta` 接口（depth, isLeaf）

### 🛠 监工验证
- `npx tsc --noEmit` 通过
- 所有类型有 JSDoc 注释
- 无任何函数实现（纯类型文件）

---

## Phase 1：核心引擎

> 5 新建文件 · 25 函数 · 7 项验证 · 5 文件可并行

### 产出
```
src/task_tree/core.ts       (~180行)  树 CRUD + 遍历
src/task_tree/lock.ts       (~100行)  TreeWriteLock
src/task_tree/persist.ts    (~150行)  saveTree/loadTree/delta/archive/cleanOld
src/task_tree/wal.ts        (~160行)  WAL append/replay/compact/clean
src/task_tree/cascade.ts    (~80行)   级联终止 + 孤儿结果收集
```

### 1A：core.ts
- [ ] `createTree(sessionId, purpose): TaskTree`
- [ ] `addChildNode(tree, parentId, node): TreeNode | null`（含 MAX_NODES=50 检查）
- [ ] `replaceSubtree(tree, nodeId, newMeaning, newTask): TreeNode | null`（删除旧子树 → 级联终止 → 新建）
- [ ] `dispatchNode(tree, nodeId, agentId): void`
- [ ] `reportResult(tree, nodeId, result, status): void`
- [ ] `checkSubtreeStatus(tree, nodeId): NodeStatusCheck[]`（visited Set + BFS 防循环引用）
- [ ] `getExecutableLeaves(tree, nodeId): TreeNode[]`
- [ ] `renderTree(tree): string`（ASC-II 格式，供 `mycoder tree` 命令）

### 1B：lock.ts
- [ ] `TreeWriteLock` 类：`acquire(id, abortController?)` / `release(id)` / `batch(id, fn)`
- [ ] 超时 30s → 触发 `holderAbortController.abort()` + 释放锁
- [ ] 可重入检测（同一 id 重复 acquire → 警告不阻塞）
- [ ] 无竞争时同步返回（不创建 Promise）

### 1C：persist.ts
- [ ] `saveTree(tree): void`（tmp + rename 原子写，经过 TreeWriteLock.batch）
- [ ] `loadTree(sessionId): TaskTree | null`
- [ ] `writeDelta / loadTreeWithDeltas`
- [ ] `compactTree / archiveTree`
- [ ] `cleanOldTrees(): void`（7 天清理，EBUSY 时 warn 不静默）
- [ ] EXDEV 处理：try renameSync → catch copyFileSync + unlinkSync

### 1D：wal.ts
- [ ] `initWal(sessionId): void`
- [ ] `appendWal(sessionId, nodeId, event, payload?): void`
- [ ] `replayWal(sessionId, tree): TaskTree`
- [ ] `compactWal(sessionId, tree): void`（**先 saveTree 再 unlinkSync WAL**）
- [ ] `cleanOldWals(): void`

### 1E：cascade.ts
- [ ] `cascadeKillTreeNode(tree, nodeId, reason): Promise<void>`（BFS + 并发度 10 + `Promise.allSettled`）
- [ ] `isAncestorAlive(tree, nodeId): boolean`
- [ ] `collectOrphanedResults(tree, nodeId): TreeEvent[]`（收集已完成但父节点已死的子节点结果）

### 🛠 监工验证（每个文件完成即验证）
- `npx tsc --noEmit` 通过
- `core.ts`：createTree → addChild × 5 → 节点数=6 → renderTree 输出正确
- `lock.ts`：3 个并发 acquire → 顺序执行无竞争 → release 后下一获得
- `lock.ts`：超时场景 → holder 的 abortController.signal.aborted === true
- `persist.ts`：saveTree → kill 进程 → loadTree 读到完整数据（tmp+rename 原子性）
- `wal.ts`：append × 60 → compact → WAL 文件被清空、tree 文件更新
- `cascade.ts`：3 层树 → kill 根 → 所有子节点 abortController.signal.aborted === true
- `cascade.ts`：子节点已完成但父节点被杀 → orphanedResults.length > 0

---

## Phase 2：LoopResult 变更

> 0 新建 · 4 修改文件 · 3 函数 + 4 字段 · 7 项验证 · ⚠️ 单向门

### 目标
agentLoop 返回类型从 `string` 改为 `LoopResult`。最小变更面，编译通过 + 回归测试。

### 产出
```
src/session_loop.ts  (修改，+20/-10)
src/cli/cli.ts       (修改，+5/-2)
src/agent_team.ts    (修改，+8/-2)
src/agent_def.ts     (修改，+5/-1)
```

### 内容清单
- [ ] `session_loop.ts`：agentLoop 返回类型改为 `Promise<LoopResult>`
- [ ] 所有 return 点改为 `{ status, text, blockedReason? }`
- [ ] end_turn → `{ status: 'success', text }`
- [ ] max iterations → `{ status: 'max_rounds', text: '(max iterations)' }`
- [ ] preRoundCheck 返回 signal → `{ status: 'killed', text: signal }`
- [ ] preRoundCheck 返回 `"blocked:..."` → 硬 break `{ status: 'blocked', text, blockedReason }`
- [ ] `cli/cli.ts`：`agentLoop()` 返回值改为 `result.text` 取文本
- [ ] `AgentTool.ts`：同步/后台模式都根据 `result.status` 分支处理
- [ ] `agent_team.ts`：`MemberState` 加 `treeNodeId?`/`treeRole?`/`depth`/`contextFiles?`
- [ ] `agent_team.ts`：`addMember` 支持 `parentDepth` 参数，自动 `depth = parentDepth + 1`
- [ ] `agent_def.ts`：`AgentEngine` 加 `activeTreeId`/`activeTreeNodeId`/`setActiveTree()`/`getTreeContext()`
- [ ] `AgentLoopParams` 加 `agentMeta?`/`fileTracker?`/`treeNodeId?` 可选参数

### 🛠 监工验证
- `npx tsc --noEmit` 通过（严格模式）
- `grep -rn "agentLoop(" src/ test/` 确认所有调用点已适配
- `echo "你好" | node dist/Mycoder.js` → 正常对话
- `echo "读 README" | node dist/Mycoder.js` → 正常 Read + 返回
- 子 Agent 正常创建 → 正常返回结果
- 子 Agent 崩溃 → status='crashed' 而非 'completed'
- 子 Agent 用满 10 轮 → status='max_rounds' 而非 'success'

---

## Phase 3：AgentTool/AgentTeam 集成 + TreeCmdTool

> 2 新建 · 3 修改文件 · 10 函数 + 6 action · 8 项验证

### 目标
任务树系统接入现有工具链。深度收窄 + 冲突检测 + 状态分级生效。

### 产出
```
src/tools-v2/AgentTool/AgentTool.ts        (修改，+50/-10)
src/tools-v2/AgentTeamTool/AgentTeamTool.ts (修改，+30/-5)
src/tools-v2/TreeCmdTool/TreeCmdTool.ts    (新建，~120行)
src/tools-v2/TreeCmdTool/prompt.ts         (新建，~5行)
src/tools-v2/index.ts                      (修改，+2)
src/session_loop.ts                        (修改，+15)
```

### 3A：AgentTool.ts
- [ ] `inputSchema` 加 `context_files`/`parent_depth` 可选字段
- [ ] `call()` 开头：MAX_NODES 检查 → 超限返回 blocked
- [ ] `call()` 开头：父节点 `isLeaf` 检查 → 如果是叶节点仍尝试 spawn → 返回提示
- [ ] `call()` 开头：`acquireFileLock(context_files)` → 冲突返回 blocked + 冲突方信息
- [ ] 首条 message 注入身份声明（role + isLeaf + 收敛规则摘要）
- [ ] preRoundCheck 增强版（调用 `isAncestorAlive` + 树事件推送）
- [ ] 结果处理：`result.status === 'success'` → completeMember + 同步树
- [ ] 结果处理：`result.status === 'blocked'` → 标记 blocked + 写 feedback
- [ ] 结果处理：`result.status === 'killed'/'crashed'/'max_rounds'` → 标记 failed
- [ ] Agent 工具**不**被移除——LLM 通过 isLeaf 自主判断是否继续分解

### 3B：AgentTeamTool.ts
- [ ] `list`：紧凑模式（每节点 1 行状态图标，~20 token/节点）
- [ ] `check`：完整状态 + result 摘要 + 发散警告（调用 detectDivergence）
- [ ] `deep`：整棵子树完整展开
- [ ] `fmtTask` 增强：显示 treeRole + depth + feedback

### 3C：TreeCmdTool.ts（新建）
- [ ] 注册到 `tools-v2/index.ts`
- [ ] `create`：createTree(purpose) → 返回 treeId
- [ ] `add_child`：addChildNode(treeId, parentId, meaning, task, role)
- [ ] `status`：checkSubtreeStatus(treeId, nodeId?)
- [ ] `report`：reportResult(treeId, nodeId, result)
- [ ] `replace`：replaceSubtree(treeId, nodeId)
- [ ] `get_leaves`：getExecutableLeaves(treeId)

### 3D：session_loop.ts 增强
- [ ] preRoundCheck 集成树事件推送
- [ ] executeTools 中挂载 fileTracker hook
- [ ] agentMeta 传递到 toolContext

### 🛠 监工验证
- Agent 工具在 Worker 上仍然可用（不被移除）
- Spawn 子 Agent → context.files 冲突时返回 blocked
- AgentTeam(list) → 紧凑输出（每行 ≤ 80 字符）
- AgentTeam(check, id) → 含 status + result + 发散信息
- TreeCmd(create) → 树文件写入 `~/.mycoder/trees/`
- TreeCmd(add_child) → 节点数 +1
- TreeCmd(status) → 返回子树状态
- `npx tsc --noEmit` 通过

---

## Phase 4：校验与恢复

> 4 新建 · 2 修改文件 · 18 函数 · 6 项验证 · 3 文件可并行

### 目标
分解质量保障 + 上下文控制 + 启动恢复。全部独立可测。

### 产出
```
src/task_tree/validate.ts     (~140行)  分解校验 + 引用验证 + 自动修复
src/task_tree/context.ts      (~100行)  300词截断 + 摘要 + 状态分级
src/task_tree/file_tracker.ts (~130行)  文件追踪 + 发散检测 + 文件锁
src/task_tree/resume.ts       (~120行)  会话恢复编排
src/Mycoder.ts                 (修改，+20)
src/session.ts                 (修改，+10)
```

### 4A：validate.ts
- [ ] `validateDecomposition(decomposition, parentContext): DecompositionQualityReport`
- [ ] Jaccard 相似度（`union.size === 0` → 返回 0，避免 NaN）
- [ ] `validateReferences(tree): ReferenceCheck`
- [ ] `repairStaleReferences(tree): number`（修复经过 TreeWriteLock.batch）
- [ ] `decomposeWithValidation(engine, taskPrompt, parentContext): TaskDecomposition`（max 2 次修正 → fallback）

### 4B：context.ts
- [ ] `truncateToWordLimit(text, maxWords): string`
- [ ] `setNodeResult(tree, nodeId, raw, role): void`（Worker→300词, Supervisor→2000字符, Planner→5000字符）
- [ ] `summarizeSubtree(tree, nodeId, depth): string`
- [ ] `formatNodeLine(node): string`

### 4C：file_tracker.ts
- [ ] `fileOwnershipMap`（与 AgentTool 冲突检测共享数据源）
- [ ] `recordFileOps(nodeId, agentId, toolName, input): void`
- [ ] `flushFileOpsToNode(tree, nodeId): {read, written}`
- [ ] `detectDivergence(tree, nodeId): DivergenceReport`
- [ ] `acquireFileLock(agentId, files): {ok} | {ok:false, conflictFile, heldBy}`
- [ ] `releaseFileLocks(agentId): void`
- [ ] `createFileTrackerHook(nodeId, agentId): function`

### 4D：resume.ts
- [ ] `resumeSessionOrchestrator(engine): ResumeResult`
- [ ] 执行顺序：loadTree → initWal → replayWal → detectLostAgents → 注入摘要 → saveTree
- [ ] `detectLostAgents(tree, sessionId): {recovered, orphaned}`
- [ ] 将 running 且 assignedAgentId 不在 agent_team 中的节点标 failed + 写 `(agent lost on crash)`

### 4E：Mycoder.ts + session.ts
- [ ] `main()` 中加 `cleanOldTrees()` + `cleanOldWals()` + `initTreeBridge()`
- [ ] `--resume` 时调 `resumeSessionOrchestrator`
- [ ] `SessionData` 加 `treeId`/`fileLocks`；`lockSession` 支持 treeId

### 🛠 监工验证
- `validateDecomposition`({purpose:"重构", parallelism:{independent:[["X"]],sequential:[],reason:""}, groups:[]}) → `passed: false`（groups 为空）
- Jaccard([], []) → 0（不 NaN）
- `truncateToWordLimit("a b c d e", 3)` → `"a b c (truncated)"`
- `acquireFileLock("a1", ["config.ts"])` → ok；`acquireFileLock("a2", ["config.ts"])` → conflict
- `resumeSessionOrchestrator` → 树文件不存在 → `resumedTree: false`，不崩溃
- `detectLostAgents` → running 节点 assignedAgentId 不存在 → 标 failed
- `npx tsc --noEmit` 通过

---

## Phase 5：提示词分层 + 边界打磨 + 端到端

> 0 新建 · 1 修改文件 · 3 函数变体 · 9 项验证

### 目标
system prompt 按角色分层、Worker 自检标记、Supervisor 二次验证、收尾边界条件。

### 产出
```
src/agent_def.ts  (修改，+20/-5)
```

### 内容清单
- [ ] `buildSystemPrompt(role?)`：按角色返回不同 prompt
- [ ] Planner prompt：树操作指引 + 义群约束（最多 8 个，原子性=一个 commit）+ 收敛规则
- [ ] Supervisor prompt：冲突处理 + "不要仅凭 [DONE] 判断，用 Read 验证" + 收敛规则
- [ ] Worker prompt：`[CHECKLIST]` + `[DONE]`/`[PARTIAL: 原因]`/`[BLOCKED: 原因]` 标记 + 收敛规则
- [ ] CWD/Date 从 system prompt 移到首条 user message（让 system prompt 可被 cache 命中）
- [ ] 未指定 role → 沿用现有 prompt（向后兼容）

### 🛠 监工验证（端到端）
- [ ] 简单任务 "读 README" → 不建树，直接 Read 完成
- [ ] 复杂任务 "重构 config.ts 缓存逻辑 + 写测试 + 更新 README" → LLM 建树 → 并行执行 → 综合汇报
- [ ] 子 Agent 完成 → 结果含 `[DONE]` → Supervisor 自动 Read 验证 → 确认通过
- [ ] 子 Agent 被 kill → 级联终止生效 → 无孤儿 Agent
- [ ] 进程强杀后 `--resume` → 加载树 → WAL 回放 → 丢失 Agent 标 failed → LLM 继续执行
- [ ] `mycoder tree` → 显示 ASC-II 树状图
- [ ] AgentTeam(list) → 每行 ≤ 80 字符，仅显示状态图标 + 义群名
- [ ] TreeCmd(status) → 返回完整子树状态
- [ ] 50 节点限制 → addChildNode 拒绝 → LLM 收到提示

---

## 执行策略

- **Phase 间串行**：不把 bug 带到下一阶段。当前 Phase 验证不通过，不进下一 Phase。
- **Phase 内并行**：独立文件同时开工，互不阻塞。
- **单向门先行**：Phase 2（LoopResult）最先暴露最大风险。如果这里卡住，后续都不用做。
- **监工不手软**：每项验证必须实际跑过——编译、grep、手动触发场景。不靠"应该没问题"。
