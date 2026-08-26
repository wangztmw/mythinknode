# 任务树精简 — 模块协调审查报告

> 审查时间：2026-08-07
> 审查范围：plan.md / work-mode.md / execution.md 三份计划文档 vs 实际代码基准

---

## 零、代码基准现状

### 实际 task_tree/ 源码状态

| 计划声称 | 实际 |
|----------|------|
| task_tree/ 11 文件, ~4,280 行 | **5 文件, 1,124 行** |

**已缺失的 6 个 .ts 源文件**（仅 dist 中有编译残留）：

| 文件 | 状态 | 仍被动态 import 引用 |
|------|------|----------------------|
| `core.ts` | MISSING | session_loop.ts, AgentTool.ts, thinker.ts, agent_def.ts |
| `persist.ts` | MISSING | AgentTool.ts, agent_def.ts, thinker.ts, Mycoder.ts |
| `validate.ts` | MISSING | AgentTool.ts, Mycoder.ts |
| `resume.ts` | MISSING | Mycoder.ts |
| `cascade.ts` | MISSING | AgentTool.ts |
| `context.ts` | MISSING | 无引用（dist 孤岛） |

**仍存在的 5 个 .ts 源文件**：

| 文件 | 行数 | 用途 |
|------|------|------|
| `file_tracker.ts` | 315 | 文件锁 + 文件操作追踪 |
| `lock.ts` | 169 | TreeWriteLock 互斥锁 |
| `paths.ts` | 47 | 路径工具函数 |
| `types.ts` | 221 | TaskTree / LoopResult / AgentMeta 类型 |
| `wal.ts` | 372 | 预写日志 (WAL) |

### TreeCmdTool 源码状态

**TreeCmdTool.ts 源文件已不存在**，但 `tools-v2/core/index.ts` 第 14 行仍有 import：

```typescript
import { TreeCmdTool } from '../task_tree/TreeCmdTool/TreeCmdTool.js';
```

该路径 `tools-v2/task_tree/TreeCmdTool/TreeCmdTool.ts` 不存在。

dist 中有两份残留编译产物：
- `dist/tools-v2/TreeCmdTool/TreeCmdTool.js`
- `dist/tools-v2/task_tree/TreeCmdTool/TreeCmdTool.js`

### 当前代码如何存活

几乎所有 task_tree 动态 import 都被 try/catch 或条件守卫保护：

- `AgentTool.ts:11` — `try { require('...lock.js').sharedLock } catch { return new TreeWriteLock() }` 
- `AgentTool.ts:40` — `if (!task.treeNodeId || !_engine?.activeTreeId) return;` (整个 syncTreeNode 短路)
- `Mycoder.ts:87` — `try { /* task_tree 模块可能未完全初始化 */ }`
- `session_loop.ts:137` — `if (params.isMainAgent ...)` (Phase 7 整块短路)

**结论**：代码已处于半退化状态，运行时依赖守卫机制降级运行。计划需要做的是完成清理，移除这些守卫和残留引用。

---

## 一、计划遗漏的引用

### 1.1 高危 — AgentTool.ts 中 syncTreeNode 之外的树代码

**严重程度**：高危

计划 Layer 4 描述为"删 syncTreeNode 函数 (~87行) + 删所有 task_tree import + 删 context_files / parent_node_id 参数"，但 AgentTool.ts 中有大量树相关代码**不在 syncTreeNode 函数内**，这些代码路径同样需要删除：

| 行号范围 | 代码块 | 说明 |
|----------|--------|------|
| ~107-130 | `addChildNode` 块 | 当 parent_node_id 传入且 activeTreeId 存在时，自动在树上创建子节点 |
| ~136-160 | `context_files` 冲突检测 | 遍历所有 running tasks，检查文件冲突，调用 acquireFileLock |
| ~188-197 | `isAncestorAlive` 检查 | 同步模式启动前检查祖先节点是否存活 |
| ~228-240 | `dispatchNode` (background) | background=true 启动时写入树节点 |
| ~267-280 | `dispatchNode` (sync mode) | 同步模式完成后写入树节点 |
| 253,260,292,299 | `releaseFileLocks` 调用 | 四处 Agent 完成/失败时的文件锁释放 |

**修复建议**：在 execution.md Layer 4 中显式列出上述每个代码块及其删除/改写方案，不要只写"删 treeNodeId 关联逻辑"。建议将 Layer 4 拆分为 Layer 4a（删 syncTreeNode）和 Layer 4b（删 execute() 内树代码）。

### 1.2 高危 — tools-v2/core/index.ts 的 TreeCmdTool import 已断裂

**严重程度**：高危

**位置**：`src/tools-v2/core/index.ts:14,30`

TreeCmdTool 源文件已不存在，但 import 和注册仍在。`npx tsc --noEmit` 会报错（如果 TreeCmdTool.ts 确实缺失）。

**修复建议**：Layer 8 执行时只需删除第 14 行 import 和第 30 行注册即可（源文件本身已不需要物理删除）。

### 1.3 中危 — agent_def.ts prompt 中的树指引需要精确定位

**严重程度**：中危

计划 Layer 9 描述为"buildSystemPrompt: 去掉 TreeCmd 使用指引"，但实际需要修改的具体行非常多：

| agent_def.ts 行号 | 内容 | 处理 |
|-------------------|------|------|
| 123-125 | `buildSystemPrompt(role?: 'planner' \| ... \| 'worktree')` 签名 | 去掉 `'worktree'` |
| 125-135 | worktree role 的专用 prompt 块 | 删除整块 |
| 165 | `TreeCmd(create) 建工作树→add_child 拆义群` | 删除/改写 |
| 166 | `[WORKTREE] 前缀的任务树` 提示 | 删除 |
| 185 | `TreeCmd: create/add_child/...` 工具列表项 | 删除 |
| 199 | `isLeaf=false，用 TreeCmd(add_child)` | 删除 |
| 206 | Planner prompt 中 `TreeCmd(create) 建树` | 重写 |
| 210 | `你是唯一的树写入者` | 删除 |
| 211 | `TreeCmd status 看全貌` | 删除 |
| 221 | `parent_node_id——这是你唯一的树扩展方式` | 删除 |

**修复建议**：execution.md Layer 9 中列出上述每行的精确变更。

### 1.4 中危 — AgentTool/prompt.ts 中的 parent_node_id 指引

**严重程度**：中危

**位置**：`src/tools-v2/agent/AgentTool/prompt.ts:3`

```
- If you created a tree node with TreeCmd(add_child), pass the returned nodeId as parent_node_id...
```

计划 Layer 4 提到"删 context_files / parent_node_id 参数"但未提及 prompt.ts 文件。

**修复建议**：Layer 4 增加一步：删除 prompt.ts 中所有 tree 相关指引行。

### 1.5 中危 — thinker.ts 调用 buildSystemPrompt('worktree')

**严重程度**：中危

**位置**：`src/work_tree/thinker.ts:72`

```typescript
engine.buildSystemPrompt('worktree'),
```

如果先删 thinker.ts（Layer 10），这行自然消失。但如果先在 agent_def.ts 中删 worktree role（Layer 3），thinker.ts 会传一个不存在的 role 导致运行时行为变化。

**修复建议**：确保 Layer 3 删除 worktree role 时，在 `buildSystemPrompt` 中添加 fallback（如 `role === 'worktree'` 时 fallback 到 'planner'），或者调换顺序：先物理删除 thinker.ts（Layer 10）再清 agent_def.ts 的 worktree role。

### 1.6 低危 — session_loop.ts 的 LoopResult 返回值

**严重程度**：低危

**位置**：`src/session_loop.ts:132`

```typescript
): Promise<LoopResult> {
```

计划 Layer 2 说"内联 LoopResult 类型定义"。需确认 session_loop.ts 中没有其他地方使用 `LoopResult` 作为函数返回值类型标注导致需要保留 import。当前确认只有第 132 行一处使用。

### 1.7 低危 — session.ts 的 treeId 字段注释

**严重程度**：低危

**位置**：`src/session.ts:18,78,87`

```typescript
treeId?: string;              // ★ 关联的任务树 ID
export function saveSession(id: string, ..., treeId?: string): void {
if (treeId) data.treeId = treeId;
```

计划 Layer 7 覆盖此删除。但需同步检查 `Mycoder.ts:97`（`saveSession(..., engine.activeTreeId || undefined)`）——这个调用点在 Layer 6 删除 resume 代码时需要同步修改 `saveSession` 调用去掉 treeId 参数。

---

## 二、调用链断裂风险

### 2.1 高危 — Mycoder.ts 的树初始化已被静默跳过

**严重程度**：高危

**位置**：`src/Mycoder.ts:22,29,65-87`

```typescript
import { cleanOldSessions } from './task_tree/persist.js';  // persist.ts 已缺失
// ...
try { cleanOldSessions(); } catch { /* 降级 */ }             // 永远走降级
// ...
const { setMemberGetter } = await import('./task_tree/validate.js'); // validate.ts 已缺失
// ...
const { resumeSessionOrchestrator } = await import('./task_tree/resume.js'); // resume.ts 已缺失
```

这些 import 全部指向已缺失的 .ts 源文件。当前代码通过 try/catch 静默降级。

**修复建议**：Layer 6 执行时，除了删除这些 import 和调用，还需要删除关联的：
- `session.treeId` 读取（第 79 行，虽然 session.ts 保留 treeId 字段但在这里已不工作）
- `engine.setActiveTree(oldTreeId)` 调用（第 85 行）
- `saveSession` 调用中的 `engine.activeTreeId` 参数（第 97 行）

### 2.2 中危 — 执行顺序矛盾：Layer 3 删 worktree role vs Layer 10 删 thinker.ts

**严重程度**：中危

Layer 3（agent_def.ts 删 worktree role）在 Layer 10（物理删除 thinker.ts）之前。

但 thinker.ts 第 72 行调用 `engine.buildSystemPrompt('worktree')`。如果 Layer 3 删了 worktree role 但不做 fallback 处理，调用会进入 default/planner 分支，可能产生意外行为。

**修复建议**：两个方案：
- A. 调换顺序：先做 Layer 10 物理删除 thinker.ts，再做 Layer 3 清 worktree role
- B. Layer 3 中不删除 worktree role，而是将其 fallback 到 planner；Layer 10 删除 thinker.ts 后再彻底删除 worktree role

### 2.3 低危 — agent_team.ts 的 treeNodeId/treeRole 字段注释链

**严重程度**：低危

**位置**：`src/agent_team.ts:30-33`

```typescript
treeNodeId?: string;       // ★ 反向链接到 TreeNode.id
treeRole?: 'planner' | 'supervisor' | 'worker';  // ★ Agent 的树角色
contextFiles?: string[];    // ★ 该 Agent 声明将操作的文件列表
```

计划 Layer 5 删除这些字段。需确保：
1. AgentTool.ts 中设置 `task.treeNodeId` / `task.treeRole` / `task.contextFiles` 的代码（Layer 4）先被删除
2. agent_team.ts 中没有其他位置读取这些字段（确认当前只在 AgentTool.ts 中写入/读取）

---

## 三、数据流分析

### 改前数据流

```
TaskTree (types.ts)
  ├─ TreeWriteLock (lock.ts) → 串行化写操作
  ├─ createTree/addChildNode/dispatchNode (core.ts) → 树结构变更  [core.ts 已缺失]
  ├─ loadTree/saveTree (persist.ts) → JSON 持久化            [persist.ts 已缺失]
  ├─ appendWal (wal.ts) → 增量操作日志
  ├─ cascade.isAncestorAlive (cascade.ts) → 祖先检查         [cascade.ts 已缺失]
  ├─ syncNodeFromMember (validate.ts) → 同步Agent结果          [validate.ts 已缺失]
  └─ file_tracker (file_tracker.ts) → 文件操作追踪+锁
```

### 改后数据流

```
Agent results → _notify → pendingNotifications → preRoundCheck 刷新 → 主Agent 上下文
```

### 数据迁移评估

| 原数据 | 生产者 | 消费者 | 迁移方案 |
|--------|--------|--------|----------|
| treeId (session) | session_loop/MYCoder | mycoder resume | 删除，不复用 |
| treeNodeId (agent_team) | AgentTool | syncTreeNode | 删除 | 
| contextFiles | AgentTool | acquireFileLock | 删除，文件锁体系废弃 |
| LoopResult 类型 | task_tree/types.ts | session_loop.ts | 内联到 session_loop.ts |
| AgentMeta 类型 | task_tree/types.ts | session_loop.ts | 内联到 session_loop.ts |
| SESSIONS_DIR | task_tree/paths.ts | session.ts, agent_team.ts | 内联到 session.ts |
| sessionPath/sessionDir | task_tree/paths.ts | session.ts | 内联到 session.ts |
| agentOutputPath/agentDir | task_tree/paths.ts | agent_team.ts | 内联到 agent_team.ts |

---

## 四、信号链清理分析

### TreeCmd → WAL → cascade → syncTreeNode 信号链

```
TreeCmdTool.execute()
  └─ core.dispatchNode / addChildNode / ...
       └─ persist.saveTree
            └─ wal.appendWal
                 └─ (compaction → unlink WAL)

cascade.isAncestorAlive()  ← AgentTool 调用

AgentTool.syncTreeNode()
  ├─ validate.syncNodeFromMember()
  ├─ persist.loadTree / saveTree
  ├─ file_tracker.flushFileOpsToNode()
  └─ wal.appendWal
```

### 清理覆盖度

| 信号链节点 | 计划覆盖层 | 源文件状态 | 评估 |
|-----------|-----------|-----------|------|
| TreeCmdTool | Layer 8 | 源文件已缺失 | import 清理即可 |
| core.dispatchNode 等 | Layer 10 | 源文件已缺失 | 物理删除 dist |
| persist.loadTree/saveTree | Layer 10 | 源文件已缺失 | 物理删除 dist |
| wal.appendWal | Layer 10 | 存在 | 物理删除 |
| cascade.isAncestorAlive | Layer 10 | 源文件已缺失 | 物理删除 dist |
| validate.syncNodeFromMember | Layer 10 | 源文件已缺失 | 物理删除 dist |
| file_tracker.* | Layer 10 | 存在 | 物理删除 |
| AgentTool.syncTreeNode | Layer 4 | 存在 | 函数删除 |
| AgentTool 内其他树代码 | Layer 4 | 存在 | 见 1.1 节 |

### 未覆盖的消费者

**file_tracker.releaseFileLocks** 在 AgentTool.ts 中的 4 次调用（行 253,260,292,299）不在 syncTreeNode 函数内。这些调用是独立于 syncTreeNode 信号链的——它们在 Agent 完成/失败的回调中被直接调用。

计划 Layer 4 如果只删除 syncTreeNode 函数，这些 releaseFileLocks 调用会残留。详见 1.1 节。

---

## 五、死代码风险评估

### 物理删除后必定成为死代码的内容

| 文件/代码块 | 死因 | 风险 |
|------------|------|------|
| `src/task_tree/` 全部 5 个文件 | 无任何 caller | 安全删除 |
| `src/work_tree/thinker.ts` | Phase 7 唯一 caller 被删 | 安全删除 |
| `agent_def.ts` 中 activeTreeId/activeTreeNodeId/setActiveTree/getTreeContext | 无 caller | 安全删除 |
| `agent_def.ts` 中 worktree role prompt | thinker.ts 被删 | 安全删除 |
| `agent_team.ts` 中 treeNodeId/treeRole/contextFiles | AgentTool 不再写入/读取 | 安全删除 |
| `session.ts` 中 treeId | Mycoder 不再传入 | 安全删除 |
| `session_loop.ts` 中 isMainAgent/agentMeta/fileTracker 参数 | 无 caller 传入有意义的值 | 安全删除 |

### 可能成为孤立的代码

| 代码 | 位置 | 风险 |
|------|------|------|
| `fileTracker` 回调参数 | session_loop.ts:29,55,66,134,211 | 如果 cli.ts 未来有人重新传入，参数还在但无实现 |
| `agentMeta` 参数注释"预留，暂不读取" | AgentTool.ts:177 | 该参数在 agent_team.ts 和 session_loop.ts 之间传递，实际从未使用 |
| `task_tree/types.ts:105-110` 依赖反转桥接注释 | types.ts | 整个文件都删，无影响 |

### 建议

1. session_loop.ts 的 `fileTracker` 参数在删除后，建议加 `@deprecated` 注释，一个版本后彻底删除
2. `agentMeta` 参数如果确实从未使用（注释说"预留，暂不读取"），可以一并删除而非保留

---

## 六、测试文件与配置文件

### 测试文件

项目无自定义测试文件（所有 test 文件均在 `node_modules/zod/` 下）。

### 配置文件

**`tsconfig.json`**：使用 `"include": ["src/**/*.ts"]`，无 task_tree 特定路径引用。物理删除后自动排除。**无风险**。

**`package.json`**：
- `"main": "dist/Mycoder.js"` — 无直接 task_tree 引用
- `"files": ["dist/", "bin/", "README.md"]` — 不影响（dist 重建后自动更新）
- `"scripts"` — 无 task_tree 引用
- **无风险**

### 文档引用

以下 Plan 目录下的 .md 文件包含 task_tree 引用（仅用于历史追踪，无需修改）：

- `Plan/MASTER_PLAN.md`
- `Plan/pipeline/plan-task-tree*.md`（6 个文件）
- `Plan/20260806-*-plan-*.md`（3 个文件）
- `Plan/调研/任务树价值评估/plan-tree-removal.md`
- `Plan/调研/claude-code运行机制/task-tree-solution-context.md`

---

## 七、总结与优先级建议

### 必须修复（阻塞执行）

| # | 问题 | 严重度 | 修复 |
|---|------|--------|------|
| 1 | AgentTool.ts 中 syncTreeNode 之外的树代码未在计划中明确列出 | 高危 | 扩展 Layer 4，拆为 4a/4b，逐块列出 |
| 2 | TreeCmdTool.ts 源文件已缺失但 import 未清理 | 高危 | Layer 8 简化为删除 import（源文件无需物理删除） |
| 3 | task_tree/ 实际只有 5 文件而非 11 文件 | 中危 | 更新 plan.md 的文件计数 |
| 4 | core/persist/validate/resume/cascade .ts 已缺失 | 高危 | 更新 plan.md 文件清单，Layer 10 只需删 dist |

### 执行顺序调整建议

| 原顺序 | 建议调整 | 原因 |
|--------|----------|------|
| Layer 3 (删 worktree role) | 移到 Layer 10 之后 | thinker.ts 仍调用 buildSystemPrompt('worktree') |
| Layer 8 (TreeCmdTool) | 保持 | import 清理即可，源文件已缺失 |
| Layer 10 (物理删除) | 拆分为 10a (删 src) + 10b (删 dist) | dist 有大量残留需单独清理 |

### 推荐执行顺序（修订版）

```
Layer 1:  cli.ts 删 isMainAgent → false
Layer 2:  session_loop.ts 删 Phase 7 + isMainAgent/agentMeta/fileTracker 参数 + 内联 LoopResult
Layer 4a: AgentTool.ts 删 syncTreeNode 函数 + prompt.ts 删 parent_node_id 指引
Layer 4b: AgentTool.ts 删 execute() 内树代码（addChildNode/contextFiles/cascade/dispatchNode/releaseFileLocks）
Layer 5:  agent_team.ts 删 treeNodeId/treeRole/contextFiles + 内联 agentOutputPath
Layer 6:  Mycoder.ts 删 cleanOldSessions/setMemberGetter/resume + 修正 saveSession 调用
Layer 7:  session.ts 删 treeId + 内联 sessionPath/SESSIONS_DIR
Layer 8:  tools-v2/core/index.ts 删 TreeCmdTool import + 注册
Layer 10a: rm src/task_tree/ + rm src/work_tree/thinker.ts
Layer 3:  agent_def.ts 删 activeTreeId/* + getTreeContext + worktree role
Layer 9:  agent_def.ts 重写 prompt（此时已无 TreeCmd 工具，可直接写新 prompt）
Layer 10b: rm -rf dist/task_tree/ + rm dist/tools-v2/TreeCmdTool/ + rm dist/tools-v2/task_tree/
Layer 11: 编译 + 测试
```

### 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| AgentTool.ts 重构遗漏树代码路径 | 高 | 编译失败 | 扩展 Layer 4 清单，逐块验证 |
| 缺失 .ts 源文件导致 tsc 报错 | 高 | 编译失败 | 先确认当前 `npx tsc --noEmit` 是否已报错 |
| 主Agent 失去树指引后编排质量下降 | 中 | 功能退化 | prompt 改写后手动测试 3 个典型场景 |
| --resume 功能完全失效 | 中 | 功能退化 | 确认 --resume 降级路径可行 |
| dist 残留干扰 | 低 | 运行时加载旧 .js | Layer 10b 彻底清理 |
