# 任务树系统 — 改善计划

> **背景**：Phase 0-5 搭建了完整骨架（10 模块，~3,000 行），但 3 个 Agent 审查发现骨架间的筋没有连上——Agent ↔ 树 ↔ 恢复三者链路断裂。
> **总缺口**：8 致命 + 13 未实现 + 10 UX 改进 = 31 项。

---

## 一、P0：链路连通（8 项致命缺口）

### F1 — 修复 `--resume` 被 lockSession 阻断

**根因**：`Mycoder.ts` 第 59 行先 `lockSession(新ID)` 覆盖旧锁，第 68 行再检查 `hasUnfinishedSession()` 读到新 ID → 找不到会话文件 → 恢复永假。

**修复**（Mycoder.ts）：
1. 把 `lockSession(sessionId)` 移到 `--resume` 逻辑**之后**
2. 从旧 session 读取 treeId，传给 `resumeSessionOrchestrator`
3. 调整启动流程：`--resume → loadSession → 恢复 messages + tree → 再 lock 新 session`

**影响**：崩溃恢复从"完全失效"→"可用"。

### F2 — 统一树 sessionId 与对话 sessionId

**根因**：TreeCmdTool 给 `createTree(autoId)` 传 `tree-{timestamp}`，会话 sessionId 是 `2026-08-06T...` 格式。两套 ID 永远不匹配——恢复时用会话 ID 找不到树文件。且 `engine.activeTreeId` 仅内存存，crash 后丢失。

**修复**（TreeCmdTool.ts + Mycoder.ts + session.ts）：
1. `create` 改用当前会话的真实 sessionId（从 engine 读取或由 Mycoder 注入）
2. 在 `saveSession` 中同步写入 `treeId: engine.activeTreeId`
3. 恢复时从 `SessionData.treeId` 读取树文件

**影响**：树和会话关联一致，重启能找到树。

### F3 — Agent 创建时设置 treeNodeId

**根因**：`AgentTool` 调 `addMember()` 创建 task，但不设置 `task.treeNodeId` 和 `task.treeRole`。`syncTreeNode` 检查 `task.treeNodeId` 始终为 undefined → 永久空操作。

**修复**（AgentTool.ts）：
1. 子 Agent 创建时，如果 `_engine.activeTreeId` 存在且调用者有 `parentNodeId` 信息，自动调用 `addChildNode` 建树节点
2. 将新节点的 `id` 写入 `task.treeNodeId`
3. 如果 LLM 显式传了 `tree_node_id` 参数则用传入的

**影响**：Agent 完成后树节点自动更新。

### F4 — 补上 dispatchNode / appendWal 调用点

**根因**：`dispatchNode` 和 `appendWal` 函数存在但零调用点。树节点永处 `pending`，WAL 永远为空。

**修复**：
1. **AgentTool.ts**：子 Agent 开始执行时调 `dispatchNode(tree, nodeId, task.id)` + `appendWal('node_dispatched', {agentId: task.id})`
2. **AgentTool.ts syncTreeNode**：完成时调 `appendWal('node_completed', {result})` 或 `'node_failed'`
3. **TreeCmdTool.ts add_child**：调 `appendWal('child_added', ...)`
4. **TreeCmdTool.ts replace**：调 `appendWal('subtree_replaced', ...)`

**影响**：树节点状态流转正常，崩溃后 WAL 有内容可回放。

### F5 — subConfig 传入 agentMeta / fileTracker / treeNodeId

**根因**：`AgentLoopParams` 声明了这三个字段，`agentLoop` 也处理了 `fileTracker`，但 `AgentTool` 构造 `subConfig` 时从未传入。

**修复**（AgentTool.ts）：
```typescript
const subConfig = {
  // ... 现有字段
  agentMeta: { depth: childDepth, isLeaf: childDepth >= 2 },
  fileTracker: createFileTrackerHook(task.id, task.treeNodeId),
  treeNodeId: task.treeNodeId,
};
```

**影响**：子 Agent 的 agentLoop 真正具备树感知能力。

### F6 — 修复 agent_def.ts import 路径

**根因**：`agent_def.ts:79` 写 `require('./task_tree/core.js')` 导入 `loadTree`，但 `loadTree` 在 `persist.ts`。`getTreeContext()` 运行时必然 crash。

**修复**（agent_def.ts）：
```typescript
const { loadTree } = require('./task_tree/persist.js');
const { renderTree } = require('./task_tree/core.js');
```

**影响**：`getTreeContext()` 可正常返回树状态。

### F7 — 修复 AgentTeamTool check/deep 传参错误

**根因**：`AgentTeamTool` 第 99、129 行将 `taskId`（成员 ID，如 `l3abc123`）作为 `sessionId` 传给 `loadTree()`。类型不匹配——`loadTree` 期望日期格式的 session ID。

**修复**（AgentTeamTool.ts）：
1. 不再在 check/deep 中尝试 loadTree——改为从 `_engine.activeTreeId` 获取当前活跃树
2. 或者传入正确的 sessionId（从 engine 读取）

**影响**：check/deep 的树状态显示从"永远找不到"→"正常显示"。

### F8 — TreeCmdTool 加 TreeWriteLock

**根因**：TreeCmdTool 的 loadTree → 修改 → saveTree 循环没有锁保护。两个并行 Agent 同时调 `add_child` → 后写的覆盖先写的。

**修复**（TreeCmdTool.ts）：
```typescript
import { TreeWriteLock } from '../../task_tree/lock.js';
const writeLock = new TreeWriteLock();
// 在所有修改操作（create/add_child/report/replace）中:
await writeLock.batch('TreeCmdTool', async () => {
  const tree = loadTree(treeId);
  // ... 修改
  saveTree(tree);
});
```

**影响**：并发写安全。

---

## 二、P1：功能补全（13 项未实现）

### 分组 A：校验与收敛（3 项）

| # | 功能 | 实现位置 | 说明 |
|---|------|---------|------|
| A1 | `decomposeWithValidation` | validate.ts | LLM 分解后校验 → max 2 次修正 → fallback 单义群 |
| A2 | `isLeaf` 检查 | AgentTool.ts | 父节点 isLeaf=true 时，LLM 仍尝试 spawn → 返回提示 |
| A3 | 安全攻击检测 | validate.ts | 同义群 Jaccard>0.9 连续 3 次标记异常；replanCount>3 上报 |

### 分组 B：桥接与集成（5 项）

| # | 功能 | 实现位置 | 说明 |
|---|------|---------|------|
| B1 | `initTreeBridge` | Mycoder.ts | 注入 `ITreeAgentBridge` 实现，解决 task_tree ↔ agent_team 循环依赖 |
| B2 | `setMemberGetter` 调用 | Mycoder.ts | 启动时设 `validateReferences` 的 getMember 闭包 |
| B3 | WAL compaction 自动触发 | wal.ts + TreeCmdTool | saveTree 后检查 WAL 条数 >= 50 → compactWal |
| B4 | Delta 集成 | persist.ts + TreeCmdTool | TreeCmdTool 的修改操作写完 saveTree 后顺便调 writeDelta |
| B5 | 级联终止集成 | AgentTeamTool.ts | `kill` action 调 `cascadeKillTreeNode` |

### 分组 C：追踪与发散（3 项）

| # | 功能 | 实现位置 | 说明 |
|---|------|---------|------|
| C1 | `acquireFileLock` 集成 | AgentTool.ts | 基于 `context.files` 在 spawn 前调 acquireFileLock |
| C2 | `flushFileOpsToNode` 调用 | AgentTool.ts | Agent 完成时 flush fileOwnershipMap → TreeNode.touchedFiles |
| C3 | 发散检测集成 | AgentTeamTool.ts | check 模式调 `detectDivergence`，输出 Missed/Untouched |

### 分组 D：缺失函数（2 项）

| # | 功能 | 位置 | 说明 |
|---|------|------|------|
| D1 | `WalEntry.payload` 加 `childId` | types.ts + wal.ts | replayWal 的 child_added 事件需要 childId |
| D2 | `addChildNode` 加完成守卫 | core.ts | 拒绝向 completed/failed/killed 节点添加子节点 |

---

## 三、P2：UX 改进（10 项建议）

| # | 优先级 | 问题 | 修复 |
|---|--------|------|------|
| U1 | 🔴 | `get_leaves` 只输出 id+meaning+status，缺 task/role/depth | 输出完整字段 |
| U2 | 🔴 | `status` 截断 nodeId（`.slice(0,10)`）→ LLM 无法用截断 ID 调后续操作 | 输出完整 nodeId |
| U3 | 🟡 | 错误消息写"treeId, parentId, meaning, task required"——不指具体缺哪个 | 分别指出缺失字段 |
| U4 | 🟡 | "tree full or parent not found" 两个故障混一个消息 | 拆成两个独立错误 |
| U5 | 🟡 | 缺 `list_trees` action | 新增，枚举 `~/.mycoder/trees/*.json` |
| U6 | 🟡 | 缺 `get_node` action | 新增，返回单节点完整信息 |
| U7 | 🟡 | 缺 `delete_node` action | 新增，删除错误创建的节点 |
| U8 | 🟢 | 重复 `create` 无警告 → 孤儿树 | 已有 activeTree 时 warn |
| U9 | 🟢 | 重复 `add_child` 无去重 | 检查同父下同 meaning 的兄弟 |
| U10 | 🟢 | `report` 重复调用静默覆盖 | 已有 result 时在响应中附旧值 |

---

## 四、附录：审查报告原文

### 附录 A：端到端生命周期缺口分析

审查范围：`Mycoder.ts`、`AgentTool.ts`、`agent_team.ts`、`session.ts`、`session_loop.ts`、`task_tree/*.ts`、`TreeCmdTool.ts`。

**A1. 启动恢复被 lockSession 阻断（致命）**

`Mycoder.ts:59` 的 `lockSession(sessionId)` 在 `--resume` 检查之前无条件执行，用新 sessionId 覆盖旧 `.lock` 文件。第 68 行 `hasUnfinishedSession()` 读到新 ID → 对应 JSON 不存在 → 返回 false → 恢复块永不进入。修复：`lockSession` 移到恢复逻辑之后。

**A2. 恢复时传错 sessionId（致命）**

`Mycoder.ts:78` 向 `resumeSessionOrchestrator` 传入的是新生成的 `sessionId`（时间戳格式），而非旧 session 的 ID。即使恢复了消息，树文件也找不到。同时 `engine.activeTreeId` 仅存内存——crash 后丢失。

**A3. 树 sessionId 与会话 sessionId 不匹配（致命）**

`TreeCmdTool.ts:40` 自动生成的 treeId 是 `tree-{timestamp}` 格式，但会话 sessionId 是 `2026-08-06T10-30-00` 格式。两套 ID 永久不匹配。`SessionData.treeId` 声明了但从未在 `saveSession` 中写入。

**A4. treeNodeId 从未设置（致命）**

`AgentTool.ts` 调 `addMember()` 创建 task 后不设置 `task.treeNodeId`。`syncTreeNode` 函数检查 `task.treeNodeId` → 永远是 undefined → 树同步永久空操作。

**A5. dispatchNode + appendWal 零调用点（致命）**

`core.ts` 的 `dispatchNode` 和 `wal.ts` 的 `appendWal` 在整个代码库中零调用。树节点永远停留在创建时的 `pending` 状态，WAL 一条日志都没写过——崩溃恢复的 replay 永远为空。

**A6. subConfig 缺 tree hook 参数（致命）**

`AgentLoopParams` 声明了 `agentMeta`、`fileTracker`、`treeNodeId` 三个字段，`agentLoop` 也正确处理了 `fileTracker`。但 `AgentTool.ts` 构造 subConfig 时三者均未传入。子 Agent 没有树感知。

**A7. agent_def.ts import 路径错误（严重）**

`agent_def.ts` 写 `require('./task_tree/core.js')` 导入 `loadTree`，但 `loadTree` 在 `persist.ts`。`getTreeContext()` 必然运行时报错。

**A8. AgentTeamTool 传参类型错误（严重）**

`AgentTeamTool.ts` 将 `taskId`（成员 ID，如 `l3abc123`）作为 `sessionId` 传给 `loadTree()`。类型不匹配——loadTree 期望日期格式 session ID。树永远查不到。

### 附录 B：计划对照审查

审查范围：全部 `src/task_tree/*.ts` + `TreeCmdTool.ts` + `AgentTool.ts` + `AgentTeamTool.ts`，对照 `plan-task-tree-overview.md`。

**B1. 未实现功能（13 项）**

1. `decomposeWithValidation` — 类型 `DecompositionResult` 存在但实现完全缺失。计划中"质量门禁"第二层收敛未落地。
2. `ITreeAgentBridge`/`initTreeBridge` — 接口在 types.ts 声明了，但没有工厂函数，`Mycoder.ts` 也没有调用。
3. `isLeaf` 检查 — AgentTool.ts 只有一个注释占位符 `// isLeaf 提示`，零代码。
4. WAL compaction 自动触发 — `COMPACTION_THRESHOLD=50` 在 wal.ts 定义，但零集成点检查阈值并调用 `compactWal`。
5. Delta 集成 — `writeDelta` 内部有 auto-compaction 逻辑，但零外部调用者。
6. 级联终止集成 — `cascade.ts` 四个导出函数零外部调用者。`AgentTeam(kill)` 不触发 `cascadeKillTreeNode`。preRoundCheck 不调用 `isAncestorAlive`。
7. 文件锁集成 — `acquireFileLock`/`releaseFileLocks` 存在但 AgentTool 不调用。AgentTool 的冲突检测自己遍历 `_tasks` Map，绕过了文件锁体系。
8. 发散检测集成 — `detectDivergence` 存在但 AgentTeamTool 不调用。
9. `flushFileOpsToNode` — 零调用。fileOwnershipMap 有记录但从不清洗到 TreeNode.touchedFiles。
10. `setMemberGetter` — validate.ts 导出了但 Mycoder.ts 不调用。`validateReferences` 永远把所有引用判为 valid。
11. 安全攻击检测（第四层收敛）— Jaccard>0.9 连续 3 次、replanCount>3、空义群连续出现——全部未实现。
12. `agentMeta` 未消费 — session_loop.ts 声明了参数但循环体从未读取。角色行为控制缺失。
13. 树节点完成守卫 — `addChildNode` 不检查父节点是否已完成/失败/被杀。

**B2. 已有 Bug（4 项）**

1. `agent_def.ts` import 路径错误（同 A7）。
2. `AgentTeamTool` sessionId 传参错误（同 A8）。
3. `replayWal` 的 `child_added` 事件用 `newChildren[0]` 做 childId——payload 类型缺 `childId` 字段。
4. `compactWal` 注释说调用者要检查阈值，但 `COMPACTION_THRESHOLD` 是私有常量未导出——外部无法检查。

**B3. 边界情况（8 项）**

1. 并发 TreeCmdTool 无锁——loadTree→修改→saveTree 无保护，后写覆盖先写。
2. saveTree .tmp 文件在 rename 前 crash 残留——cleanOldTrees 跳过 .tmp 文件。
3. WAL compaction 在 saveTree 和 unlinkSync 之间 crash 可能双重重放。
4. `_idSeq` 重启归零——理论上可碰撞同毫秒生成的旧 ID。
5. `collectDescendantIds` 的 BFS 有 visited Set 但在 push 之后检查。
6. `allAncestorsPassed` 不验证 parentId 存在于 tree.nodes。
7. `compactWal` 重置 seqCounters——并发写新条目时 seq 冲突。
8. `writeDelta` auto-compaction 文件计数有竞态窗口。

### 附录 C：TreeCmdTool LLM 使用体验审查

**C1. 参数混淆**

- `parentId` vs `nodeId` 语义相近，LLM 容易混用。
- 10 个可选参数平铺，LLM 可能在 report 时传 purpose（被静默忽略）。
- `meaning` vs `purpose` vs `task` 三个名字语义重叠。

**C2. 错误消息不自愈**

- `"treeId, parentId, meaning, task required"` — 不指出具体缺哪个，LLM 只能猜。
- `"tree full or parent not found"` — 两个不相关的故障混一个消息。
- `"Tree X not found"` — 文件损坏/不存在返回同一消息，LLM 无法区分。

**C3. 缺失操作**

| 缺失 | 影响 |
|------|------|
| `list_trees` | 重启后 LLM 无法发现已有树 |
| `get_node` | 无单节点详情，只能 dump 全树 |
| `delete_node` | 创建错误只能 replace 整个父节点 |
| `update_node` | 无法改 meaning/task/role |
| `move_node` | 无法重新挂载 |
| `block/unblock` | status 类型有 blocked 但工具不暴露 |

**C4. auto-detection 半生效**

`treeId = params.treeId || engine?.activeTreeId` — 逻辑存在但：无活跃树时错误消息不说明 auto-detect 为何失败；重启后 `engine.activeTreeId` 永为 null。

**C5. 输出格式问题**

- `get_leaves` 缺 `task`、`role`、`depth`——LLM 只看标签不知具体任务
- `status` 截断 nodeId（`.slice(0,10)`）导致后续操作不可用
- `childrenSummary` 格式（`"3C/0F/1R/2P"`）未解释
- `renderTree` 符号（◌●⊘✓✗☠）无图例

**C6. 幂等性隐患**

- 重复 `create` → 孤儿树（旧树仍在磁盘，engine 指向新树）
- 重复 `add_child` → 两个相同 meaning 的子节点
- 重复 `report` → 静默覆盖旧结果

---

## 五、执行监督计划

### 原则

- **分层 Agent 结构**：一个监工 Agent 管一组修复，子 Agent 并行执行具体文件改动
- **先 P0 后 P1/P2**：P0 是链路连通——没连上之前 P1/P2 无从验证
- **每个修复有验收标准**：编译通过 + 逻辑验证（grep 调用点 + 手动触发场景）

### Agent 布局

```
监工 Agent（根）
  │
  ├─→ P0 组（4 个 Worker 并行）
  │     Worker A: Mycoder.ts 启动流修复（F1+F2）
  │     Worker B: AgentTool.ts 链路修复（F3+F4+F5）
  │     Worker C: TreeCmdTool.ts 修复（F8+U1+U2+U3+U4+U5）
  │     Worker D: agent_def + AgentTeamTool 修复（F6+F7）
  │
  ├─→ P1-A 组（校验/收敛，2 个 Worker）
  │     Worker E: validate.ts（A1+A3+D1）
  │     Worker F: AgentTool.ts（A2+C1+C2）
  │
  ├─→ P1-B 组（桥接/集成，2 个 Worker）
  │     Worker G: Mycoder.ts（B1+B2）+ cascade 集成（B5）
  │     Worker H: wal/persist 集成（B3+B4+D2）
  │
  └─→ P2 组（UX，2 个 Worker）
        Worker I: TreeCmdTool.ts（U6+U7+U8+U9+U10）
        Worker J: AgentTeamTool.ts（C3）
```

### 验收标准

每层执行完毕后，监工 Agent 验证：

1. `npx tsc --noEmit` 零错误
2. `grep -rn "调用函数名" src/` 确认所有新增调用点存在
3. 关键链路手动验证：
   - P0 后：`create → add_child → Agent spawn → Agent 完成 → 树节点状态 updated → --resume 恢复`
   - P1 后：`decomposeWithValidation 工作 → isLeaf 拦截 → 级联终止生效 → WAL auto-compact`
   - P2 后：`get_leaves 输出完整 → list_trees 可用 → 重复操作有提示`

### 执行顺序

```
Phase 6a: P0 链路连通（4 Worker 并行，1 轮）
    ↓ 监工验证：编译 + grep + 烟尘测试
Phase 6b: P1 功能补全（2 组各 2 Worker，2 轮）
    ↓ 监工验证：编译 + 功能测试
Phase 6c: P2 UX 改进（2 Worker 并行，1 轮）
    ↓ 监工验证：编译 + 交互测试
完成
```
