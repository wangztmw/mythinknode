# 任务树系统 — 完整实施计划 v2

> **创建时间**：2026-08-06 | **修订**：2026-08-06（6 Agent 并行审查后定稿）
> **前置**：agentLoop() 统一循环 + agent_team 共享白板 + 双向反馈（均已完成）
> **设计原则**：保留全部功能，追求清晰优雅；薄基础设施 + 厚 LLM 能力

---

## 一、设计理念

### 1.1 核心思想

不是"主 Agent 派活给子 Agent"。而是 **"义群分解 → 建树 → 执行树"** 的完整流程。LLM 是决策者，基础设施是安全网——安全网只做异常兜底，不做常态决策替代。

### 1.2 什么是义群（Meaning Group）

义群按照**语义动作**划分的独立工作单元。不同于按文件或步骤划分——义群关心的是"做什么动作"。每个义群可被递归分解，直到不可再分的叶节点。

### 1.3 三层角色

| 层 | 角色 | 工具 | 轮次 | 职责 |
|----|------|------|------|------|
| 根 | Planner | 全部 | 25 | 分析→分解→派分支→收报告→综合→回复 |
| 分支 | Supervisor | 只读+Agent+AgentTeam+TreeCmd | 10 | 派叶节点→监督进度→收结果→汇报 |
| 叶 | Worker | 只看任务需要 | 5 | 干一件具体的事→返回结果→销毁 |

### 1.4 两阶段执行

**建树阶段（理解）**：一次 LLM 结构化输出（TaskDecomposition），产出 purpose + parallelism + groups。义群递归分解由各层 Agent 自行迭代，非根节点一次性决定整棵树。

**执行阶段（干活）**：根读树→dispatch 并行分支→等完成→失败则 replaceSubtree 重新分解。

---

## 二、模块化文件设计

不把所有东西塞进一个 `task_tree.ts`。按职责拆分为 10 个聚焦模块，每个文件只管一件事。

```
src/task_tree/
  types.ts           (~130行)  所有类型定义
  core.ts            (~180行)  树的基础 CRUD + 遍历
  lock.ts            (~100行)  TreeWriteLock 进程内互斥锁
  wal.ts             (~160行)  WAL 预写日志（append/replay/compact）
  cascade.ts         (~80行)   级联终止 + 孤儿结果收集
  validate.ts        (~140行)  分解校验 + 引用验证 + 修复
  persist.ts         (~150行)  saveTree/loadTree/delta/archive/cleanOld
  context.ts         (~100行)  上下文控制（截断/摘要/分级）
  file_tracker.ts    (~130行)  文件追踪 + 发散检测
  resume.ts          (~120行)  会话恢复编排
  index.ts           (~10行)   统一导出
```

共计 **~1,300 行**，每个文件职责单一、可独立测试。

---

## 三、数据结构

### 3.1 TreeNode（types.ts）

```typescript
interface TreeNode {
  id: string;
  parentId: string | null;
  meaning: string;
  context: { files: string[]; concepts: string[] };
  task: string;
  role: 'planner' | 'supervisor' | 'worker';
  status: 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'killed';
  assignedAgentId: string | null;
  depth: number;                  // 0=root, 1=branch, 2=leaf
  maxRounds: number;
  tools: string[] | null;        // null=用角色默认值
  result: string | null;
  replanCount: number;
  children: string[];
  touchedFiles: {                 // 运行时追踪（非 LLM 预测）
    read: string[];
    written: string[];
  };
}

interface TaskTree {
  sessionId: string;
  rootId: string;
  nodes: Record<string, TreeNode>;
  createdAt: number;
  updatedAt: number;
  version: number;
}
```

### 3.2 关键新增类型（types.ts）

```typescript
// agentLoop 结构化返回（替代裸 string）
type LoopStatus = 'success' | 'max_rounds' | 'killed' | 'blocked' | 'crashed';
interface LoopResult { status: LoopStatus; text: string; blockedReason?: string; }

// 依赖反转桥接（解决 task_tree ↔ agent_team 循环依赖）
interface ITreeAgentBridge {
  getMember(id: string): MemberState | undefined;
  completeMember(id: string, output: string, role?: string): void;
  onTreeNodeSynced(nodeId: string, status: string, result?: string): void;
}

// 树操作事件（供 AgentTeamTool 消费）
type TreeEvent = 
  | { type: 'node_completed'; nodeId: string; result: string }
  | { type: 'node_failed'; nodeId: string; reason: string }
  | { type: 'node_blocked'; nodeId: string; feedback: string }
  | { type: 'children_all_done'; nodeId: string };
```

---

## 四、各模块详细设计

### 4.1 core.ts — 树基础操作（~180 行）

**职责**：createTree、addChildNode、replaceSubtree、dispatchNode、reportResult、checkSubtreeStatus、getExecutableLeaves、renderTree。

**关键约束**：
- `addChildNode` 内 MAX_NODES=50 硬限制，超限拒绝并提示 LLM 简化任务
- `replaceSubtree` 执行旧子树级联终止 + 新子树替换 + version++
- `checkSubtreeStatus` 内置 `visited` Set 防循环引用无限递归，使用迭代 BFS
- `renderTree` 输出 ASC-II 格式（`mycoder tree` 命令使用）

### 4.2 lock.ts — TreeWriteLock（~100 行）

**职责**：进程内 Promise 队列互斥锁，所有树写操作必须经过。

```typescript
class TreeWriteLock {
  private locked = false;
  private holder: string | null = null;
  private queue: Array<{ id: string; resolve: () => void; timer: NodeJS.Timeout }> = [];
  private holderAbortController: AbortController | null = null;

  // 超时 30s。★ 超时时触发 holder 的 abortController，通知原持有者释放
  async acquire(id: string, abortSignal?: AbortController): Promise<void>;
  release(id: string): void;

  // 批量操作入口：回调在持锁期间执行，保证原子性
  async batch<T>(id: string, fn: () => Promise<T>): Promise<T>;
}
```

**审查修复**：超时时不静默释放锁——通过 `holderAbortController.abort()` 通知原持有者，避免双持锁（split-brain）。原持有者的写操作在下一轮 agentLoop 检测到 abort 后放弃。

### 4.3 wal.ts — WAL 预写日志（~160 行）

**职责**：append-only 状态变更记录。崩溃后回放重建树状态。

```typescript
// 单条日志
interface WalEntry {
  seq: number; ts: number; sessionId: string; nodeId: string;
  event: 'node_created' | 'node_dispatched' | 'node_completed' | 'node_failed' 
       | 'node_blocked' | 'node_replanned' | 'child_added' | 'subtree_replaced';
  payload: { agentId?: string; result?: string; reason?: string; 
             oldChildren?: string[]; newChildren?: string[] };
}

// 追加一条日志（appendFileSync，异步版本可选）
function appendWal(sessionId: string, nodeId: string, event: WalEntry['event'], payload?: WalEntry['payload']): void;

// 回放 WAL → 重建内存树
function replayWal(sessionId: string, tree: TaskTree): TaskTree;

// ★ 审查修复：compaction 先写新 tree 再删旧 WAL（防止 crash 在二者之间数据丢失）
// 步骤: 1) saveTree(newTree) → 2) renameSync(newTree, treePath) → 3) unlinkSync(walPath)
function compactWal(sessionId: string, tree: TaskTree): void;

// 清理
function cleanOldWals(): void;
```

**compaction 正确做法**（修复崩溃窗口）：
```
旧方案（有 bug）: unlinkSync(wal) → saveTree(tree)  // crash here → 数据丢失
新方案（修复后）: saveTree(tmp) → renameSync(tmp, path) → unlinkSync(wal)  // 原子覆盖
```

compaction 阈值：50 条 WAL 条目触发一次全量快照。

### 4.4 cascade.ts — 级联终止（~80 行）

**职责**：父节点被杀 → 递归终止所有子孙，收集孤儿结果。

```typescript
// 级联终止：BFS 遍历，并发度 10（Promise.allSettled 防单点失败阻塞）
async function cascadeKillTreeNode(tree: TaskTree, nodeId: string, reason: string): Promise<void>;

// 检查祖先是否存活（子 Agent preRoundCheck 中调用）
function isAncestorAlive(tree: TaskTree, nodeId: string): boolean;

// ★ 审查修复：收集已完成的孤儿节点结果，注入父级通知队列
function collectOrphanedResults(tree: TaskTree, nodeId: string): TreeEvent[];
```

**关键修复**：Supervisor 被 kill 后，其下已完成但未上报的 Worker 结果不被丢弃。`cascadeKillTreeNode` 遍历子节点时检查 `status === 'completed'`，收集结果注入通知队列。

### 4.5 validate.ts — 校验与修复（~140 行）

**职责**：分解质量校验 + 引用完整性验证 + 自动修复。

```typescript
// 分解校验
interface DecompositionQualityReport {
  passed: boolean;
  overDecomposed: string[];
  inconsistent: string[];
  warnings: string[];
}

function validateDecomposition(
  decomposition: TaskDecomposition,
  parentContext: { files: string[]; concepts: string[] }
): DecompositionQualityReport;

// ★ 审查修复：Jaccard 相似度除零处理
// function jaccardSimilarity(a: string[], b: string[]): number {
//   const union = new Set([...a, ...b]);
//   if (union.size === 0) return 0; // ★ 两个空集 → 相似度 0，避免 NaN
//   const inter = new Set([...a].filter(x => new Set(b).has(x)));
//   return inter.size / union.size;
// }

// 引用验证
interface ReferenceCheck { valid: number; stale: string[]; orphaned: string[]; }

function validateReferences(tree: TaskTree): ReferenceCheck;

// 自动修复（保留——用户要求）
function repairStaleReferences(tree: TaskTree): number;

// 带校验的分解（max 2 次 LLM 修正 → fallback 单义群）
async function decomposeWithValidation(
  engine: AgentEngine,
  taskPrompt: string,
  parentContext: { files: string[]; concepts: string[] }
): Promise<TaskDecomposition>;
```

**fallback 修正**（审查发现）：fallback 单义群时将任务委托给执行型子 Agent（创建 Worker 执行），而非让当前编排型 Agent 直接执行——避免角色混淆。

### 4.6 persist.ts — 持久化（~150 行）

**职责**：saveTree、loadTree、Delta 增量写入、归档、清理。

```typescript
// 原子保存（tmp+rename，经过 TreeWriteLock）
function saveTree(tree: TaskTree): void;

// 加载
function loadTree(sessionId: string): TaskTree | null;

// 增量写入（Delta）
interface TreeDelta { sessionId: string; version: number; nodeUpdates: Partial<TreeNode>[]; }

function writeDelta(tree: TaskTree, delta: TreeDelta): void;
function loadTreeWithDeltas(sessionId: string): TaskTree | null; // 加载基础 + 回放 delta

// 文件大小超限时归档 + 精简
function compactTree(tree: TaskTree): TaskTree;

// 7 天清理
function cleanOldTrees(): void;

// ★ 审查修复：saveTree 的 try-catch 处理 EXDEV（跨文件系统 rename）
// try { renameSync(tmp, path); } catch (e) {
//   if (e.code === 'EXDEV') { copyFileSync(tmp, path); unlinkSync(tmp); }
//   else throw e;
// }

// ★ 审查修复：cleanOldTrees 的 unlinkSync 被 EBUSY 时 console.warn 而非静默 skip
```

### 4.7 context.ts — 上下文控制（~100 行）

**职责**：结果截断、层次化摘要、状态分级渲染。

```typescript
// 300 词截断
function truncateToWordLimit(text: string, maxWords: number): string;

// 写入结果时自动截断
function setNodeResult(tree: TaskTree, nodeId: string, raw: string, role: string): void;
// Worker → 300 词，Supervisor → 2000 字符，Planner → 5000 字符

// 层次化摘要
function summarizeSubtree(tree: TaskTree, nodeId: string, depth: 'branch' | 'leaf' | 'all'): string;

// 紧凑单行格式（list 模式）
function formatNodeLine(node: TreeNode): string; // "✓ 改loadConfig — 缓存逻辑已添加"
```

### 4.8 file_tracker.ts — 文件追踪（~130 行）

**职责**：运行时收集实际文件操作，检测预测与实际发散。

```typescript
// 文件操作记录（★ 与内存文件锁共享同一个 Map，统一数据源）
const fileOwnershipMap: Map<string, { agentId: string; nodeId: string; operation: 'read' | 'write' }> = new Map();

function recordFileOps(nodeId: string, agentId: string, toolName: string, input: Record<string, unknown>): void;

// Flush 到树节点
function flushFileOpsToNode(tree: TaskTree, nodeId: string): { read: string[]; written: string[] };

// 发散检测
interface DivergenceReport { nodeId: string; predicted: string[]; actual: string[]; missed: string[]; untouched: string[]; isDivergent: boolean; }
function detectDivergence(tree: TaskTree, nodeId: string): DivergenceReport;

// 文件锁：写操作前获取，完成后释放
function acquireFileLock(agentId: string, files: string[]): { ok: true } | { ok: false; conflictFile: string; heldBy: string };
function releaseFileLocks(agentId: string): void;

// agentLoop hook
function createFileTrackerHook(nodeId: string, agentId: string): (toolName: string, input: Record<string, unknown>) => void;
```

**关键修复**：文件追踪（recordFileOps）和文件锁（acquireFileLock）共享同一个 `fileOwnershipMap`，消除双重维护问题。不再使用全局数组 `fileOps`——改为写入 agent_team 的 outputFile，避免并发竞态。

### 4.9 resume.ts — 会话恢复（~120 行）

**职责**：崩溃后恢复编排。

```typescript
interface ResumeResult {
  resumedMessages: boolean;
  resumedTree: boolean;
  lostAgentsRecovered: number;
  summary: string;
}

// 统一恢复入口（启动时调用，在 TreeWriteLock 初始化之后）
function resumeSessionOrchestrator(engine: AgentEngine): ResumeResult;

// 执行顺序: loadTree → initWal → replayWal → detectLostAgents → 注入摘要 → saveTree
// ★ 审查修复：replayWal 内部通过 batchTreeOperation 走 TreeWriteLock

// 检测崩溃中丢失的 agent
function detectLostAgents(tree: TaskTree, sessionId: string): { recovered: string[]; orphaned: string[] };
// 将 running 且 assignedAgentId 不在 agent_team 中的节点标 failed
```

**崩溃恢复策略**：启动时把所有 running 节点标 failed 并记录 `(agent lost on crash)`。LLM 恢复后看到树状态，自行决定哪些需要 replaceSubtree。WAL 回放 + 自动修复提供双重保障。

### 4.10 index.ts — 统一导出（~10 行）

```typescript
export * from './types.js';
export * from './core.js';
export * from './lock.js';
export * from './wal.js';
export * from './cascade.js';
export * from './validate.js';
export * from './persist.js';
export * from './context.js';
export * from './file_tracker.js';
export * from './resume.js';
```

---

## 五、现有文件改动

### 5.1 agent_team.ts（+8 行）

```typescript
// MemberState 新增字段
interface MemberState {
  // ... 现有字段
  treeNodeId?: string;         // 反向链接到 TreeNode
  treeRole?: 'planner' | 'supervisor' | 'worker';
  depth: number;
  contextFiles?: string[];     // 该 Agent 将操作的文件
  conflicts?: string[];        // 与之冲突的其他 Agent ID
}

// addMember 签名扩展
function addMember(type, subject, desc?, parentDepth?: number): MemberState;

// completeMember 扩展：同步树节点状态
// ★ 通过 ITreeAgentBridge 调用，避免循环依赖
```

### 5.2 session_loop.ts（+35 行）

```typescript
// AgentLoopParams 新增
interface AgentLoopParams {
  // ... 现有字段
  agentMeta?: { depth: number; isLeaf: boolean };
  fileTracker?: (toolName: string, input: Record<string, unknown>) => void;
  treeNodeId?: string;
}

// agentLoop 返回类型改为 LoopResult（破坏性变更——单向门）
async function agentLoop(engine, params): Promise<LoopResult>;

// preRoundCheck 增强：按需推送 + 级联终止感知
// ★ 审查修复：preRoundCheck 返回 "blocked:..." 时 agentLoop 硬 break，
//   不依赖 LLM 理解文本。直接返回 LoopResult { status: 'blocked', ... }
```

### 5.3 agent_def.ts（+20 行）

```typescript
// buildSystemPrompt 扩展：按角色分层加载
// Planner prompt: 树操作 + 三层角色 + 义群约束（~350 tokens）
// Supervisor prompt: 冲突处理 + 监督职责 + Worker 验证指引（~180 tokens）
// Worker prompt: 自检标记 [CHECKLIST]+[DONE]/[PARTIAL]/[BLOCKED]（~60 tokens）
// 每种角色只加载自己的部分，不全部堆进去

// ★ 审查修复：CWD/Date 等动态信息从 system prompt 移到首条 user message，
//   让 system prompt 可被 Anthropic prompt cache 命中

// Worker 二次验证指引（Supervisor prompt 中）：
// "不要仅凭 Worker 的 [DONE] 标记判断完成。对每个完成的 Worker，
//  至少用 Read 打开其声称修改的文件，确认改动存在。"
```

### 5.4 AgentTool.ts（+50 行）

```typescript
// inputSchema 扩展
const inputSchema = z.object({
  // ... 现有字段
  context_files: z.array(z.string()).optional(),
  parent_depth: z.number().optional(),
});

// call() 新增逻辑（按顺序）:
// 1. depth 检查：myDepth >= 2 → 拒绝创建，返回 blocked
// 2. isLeaf 判断：childDepth >= 2 → 工具集移除 Agent 工具
// 3. context.files 冲突检测：acquireFileLock → 冲突 → blocked + notify
// 4. 身份声明注入首条消息
// 5. preRoundCheck 增强版（按需推送 + 级联感知）
// 6. 结果处理：根据 LoopResult.status 分支（success → completeMember, blocked → 标记 blocked 等）
```

### 5.5 AgentTeamTool.ts（+30 行）

```typescript
// list 模式增强：每节点 1 行紧凑状态（~20 token/节点）
// check 模式增强：单节点完整状态 + 发散警告
// deep 模式新增：整棵子树完整展开

// ★ 审查修复：list/check 通过 TreeEvent 消费树状态，不直接 loadTree
```

### 5.6 TreeCmdTool.ts（新建，~120 行）

```typescript
// 新工具：专门管理 TreeNode 操作
const inputSchema = z.object({
  action: z.enum(['create', 'add_child', 'status', 'report', 'replace', 'get_leaves']),
  treeId: z.string().optional(),
  parentId: z.string().optional(),
  nodeId: z.string().optional(),
  // ...
});
// 注册到 tools-v2/index.ts
```

### 5.7 session.ts（+10 行）

```typescript
// SessionData 新增
interface SessionData {
  // ... 现有字段
  treeId?: string;
  fileLocks?: Record<string, string>; // 恢复时重建文件锁
}

// lockSession 记录 treeId
// getLockedTreeId 读取锁中的 treeId
// ★ 审查修复：saveSession 同时保存 fileLocks 快照
```

### 5.8 Mycoder.ts（+20 行）

```typescript
// 启动流程新增：
// 1. cleanOldMembers()    ← 已有
// 2. cleanOldTrees()      ← 新增
// 3. cleanOldWals()       ← 新增
// 4. initTreeBridge()     ← 新增（注入 ITreeAgentBridge 实现）
// 5. lockSession(id, treeId)
// 6. if (--resume): resumeSessionOrchestrator(engine)
// 7. agentLoop ...
```

### 5.9 cli.ts（+5 行）

```typescript
// 适配 agentLoop 新返回类型
const loopResult = await agentLoop(engine, {...});
const resultText = loopResult.text;  // 曾是裸 string
```

---

## 六、交叉冲突解决方案

六组方案之间的交互经审查，发现以下需要协调的点：

| # | 冲突 | 解决方案 |
|---|------|---------|
| 1 | TreeWriteLock 与 WAL 初始化顺序 | resume.ts 必须在 lock.ts 初始化之后执行；WAL 重放通过 `TreeWriteLock.batch()` |
| 2 | 文件追踪与文件锁共享数据源 | 统一使用 `fileOwnershipMap`，tracker 和 lock 读写同一 Map |
| 3 | decomposeWithValidation 与 isSimpleTask 判断顺序 | isSimpleTask 短路在前（纯启发式），不匹配再走 decomposeWithValidation |
| 4 | LoopResult 与 preRoundCheck blocked 信号 | agentLoop 内硬逻辑：preRoundCheck 返回 `"blocked:..."` → break 返回 `{status:'blocked'}` |
| 5 | checkSubtreeStatus 自动修复与 TreeWriteLock | 修复必须通过 `TreeWriteLock.batch()`，修复前检查节点当前状态防覆盖 |
| 6 | task_tree ↔ agent_team 循环依赖 | `ITreeAgentBridge` 接口 + 启动时依赖注入（Mycoder.ts 中实现） |

---

## 七、实施路线

### Phase 0：类型与接口（1-2 天）
- 定义所有共享类型：TreeNode, TaskTree, LoopResult, ITreeAgentBridge, TreeEvent 等
- 新建 `src/task_tree/types.ts`
- **零风险**——纯类型定义，不改任何现有代码

### Phase 1：核心引擎（3-5 天）
- core.ts：基础 CRUD + 树遍历
- lock.ts：TreeWriteLock
- persist.ts：saveTree/loadTree/delta/archive
- wal.ts：append/replay/compact
- cascade.ts：级联终止
- **可并行开发**，各模块通过 types.ts 接口耦合

### Phase 2：LoopResult 变更（2-3 天，⚠️ 单向门）
- agentLoop 返回类型改为 LoopResult
- 适配 cli.ts + AgentTool.ts
- 所有调用点 grep 验证
- **独立 PR，充分测试后合入**

### Phase 3：AgentTool/AgentTeam 集成（3-4 天）
- depth 检查 + isLeaf 工具过滤 + 冲突检测
- AgentTeam 三级分级
- TreeCmdTool 新建并注册
- preRoundCheck 增强

### Phase 4：校验与恢复（2-3 天）
- validate.ts：分解校验 + 引用验证 + 自动修复
- context.ts：300词截断 + 摘要
- file_tracker.ts：文件追踪 + 发散检测
- resume.ts：启动恢复编排

### Phase 5：提示词与打磨（2-4 天）
- agent_def.ts 按角色分层 prompt
- Worker 自检标记 + Supervisor 二次验证指引
- 边界条件补丁 + 端到端测试

**总周期：4-6 周**。代码量 ~1,300 行（task_tree/）+ ~180 行（现有文件改动）= ~1,480 行。

---

## 八、关键约束速查

| 约束 | 值 | 位置 |
|------|-----|------|
| 最大深度 | 2（0=root, 1=branch, 2=leaf） | cascade.ts |
| 最大节点数 | 50 | core.ts addChildNode |
| WAL compaction 阈值 | 50 条 | wal.ts |
| TreeWriteLock 超时 | 30s（触发 holder abort） | lock.ts |
| 级联终止并发度 | 10 | cascade.ts |
| Worker 结果截断 | 300 词 | context.ts |
| Supervisor 结果截断 | 2000 字符 | context.ts |
| 树文件大小上限 | 100KB | persist.ts |
| 树/WAL 清理周期 | 7 天 | persist.ts, wal.ts |
| decomposeWithValidation 重试 | max 2 次 | validate.ts |
| 最大义群数 | 8 个 | validate.ts |
| Jaccard 过度分解阈值 | 0.8 | validate.ts |

---

## 九、附录 A：审查报告摘要

六组方案经 6 个 Agent 并行审查（交叉冲突、实现风险、性能、遗漏边界、实施成本、架构一致性），主要发现及修复：

### A.1 必须修复的 Bug（已纳入设计）

1. **WAL compaction 崩溃窗口**：先 unlinkSync 再 saveTree → 改为先 saveTree 再 unlinkSync
2. **TreeWriteLock 超时双持锁**：超时时触发 holder.abortController，通知原持有者
3. **renameSync EXDEV**：try-catch + copyFileSync fallback
4. **Jaccard 除零**：`union.size === 0` 时返回 0
5. **Supervisor 被杀→孤儿结果**：cascadeKillTreeNode 中收集已完成子节点结果
6. **checkSubtreeStatus 循环引用**：使用 visited Set + BFS 迭代
7. **cleanOldTrees EBUSY 静默 skip**：console.warn 输出被跳过的文件

### A.2 性能结论

MVP 每轮 agentLoop 新增 ~0.15ms（纯内存操作），占 LLM API 延迟（2-10s/轮）的 < 0.02%。WAL appendFileSync 每状态变更 ~1ms，compaction 阈值 50 条保证 WAL 不过度累积。启动恢复 ~30ms，用户不可感知。稳态内存 ~25KB，可忽略。

### A.3 设计改进

- **模块化拆分**：1 个 700 行文件 → 10 个 ~130 行文件，每个职责单一
- **依赖反转**：ITreeAgentBridge 解决 task_tree ↔ agent_team 循环依赖
- **按角色分层 prompt**：Planner/Supervisor/Worker 只加载自己的指引，system prompt 总量不膨胀
- **动态内容移出 system prompt**：CWD/Date 放入首条 user message，prompt cache 可命中

---

## 附录 B：相关文档

| 文档 | 路径 |
|------|------|
| Agent 树状集群设计 | Plan/pipeline/plan-agent-tree.md |
| 双向反馈机制 | Plan/pipeline/plan-subagent-feedback.md |
| 统一 Agent 循环 | Plan/pipeline/plan-unified-agent-loop.md |
| 上下文/存储/引用完整性 | Plan/pipeline/claude-code-study/task-tree-solution-context.md |
| 审查报告全量 | Plan/pipeline/plan-task-tree-review.md |
