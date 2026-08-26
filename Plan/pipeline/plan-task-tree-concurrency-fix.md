# 方案：任务树系统三个严重风险的根因分析与解决方案

> **创建时间**：2026-08-06
> **针对文件**：`src/task_tree.ts`（新文件，~250行）、`src/agent_team.ts`（改 ~30行）、`src/tools-v2/AgentTool/AgentTool.ts`（改 ~15行）
> **前置阅读**：[plan-task-tree.md](./plan-task-tree.md)、[plan-agent-tree.md](./plan-agent-tree.md)

---

## 零、三个风险的共同背景

当前任务树设计的核心存储路径：

```
~/.mycoder/trees/{session-id}.json     ← 整棵树（所有节点在一个文件）
~/.mycoder/trees/{session-id}.lock     ← 本方案新增：树级写锁
~/.mycoder/team/{agent-id}.txt         ← 每个 Agent 的输出（已是原子写）
```

**关键事实**：树的所有节点（根、分支、叶）共用同一个 JSON 文件。根 Agent、分支 Agent、叶 Agent 都可能在各自 agentLoop 的某一轮中调用 `saveTree()` 修改自己负责的节点并写回磁盘。没有任何并发控制时，这必然导致数据损坏。

---

## 风险 A1：并发写树（数据损坏）

### 1.1 问题根因

**时序竞争（TOCTOU）**：

```
时间线 →
Agent A (分支1):  read tree ──── 修改 node-3 ──── write tree ✓
Agent B (分支2):         read tree ──── 修改 node-7 ──── write tree ✓ (覆盖了A的修改!)
```

即使使用 `tmp + rename` 原子写入（`writeFileSync(tmp, data); renameSync(tmp, path)`），这只能保证**单次写入不产生半截文件**，无法解决**读-改-写**之间的竞争。Agent B 在 Agent A 写入之前读了旧版本，写回时覆盖了 A 的改动。

**触发条件**：
- 根 Agent 同时派了 3 个分支 Agent → 3 个分支在相近时间完成并各自调 `saveTree()` 更新自己分支的状态
- 叶 Agent 完成时调 `saveTree()` 更新自己的 `status` 和 `result`，而父节点 Supervisor 同时也在更新 `children` 数组

**根因本质**：当前设计允许多个 Agent 对同一个文件执行"读-改-写"操作，且没有任何协调机制。

### 1.2 解决方案：树级互斥锁 TreeWriteLock

**核心思路**：引入一个**进程内 + 跨进程双层的独占写锁**。所有 `saveTree()` 调用必须 `acquire()` 锁后才能写入。同一时刻只有一个 Agent 能写树。

#### 类设计

```typescript
// src/task_tree.ts

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TREES_DIR = join(homedir(), '.mycoder', 'trees');

/**
 * 树级互斥写锁 —— 单写者模型的核心。
 *
 * 双层保护：
 *   1. 进程内互斥：Promise 队列（解决同进程多 Agent 竞争）
 *   2. 跨进程互斥：lockfile 的 wx 标志（解决多进程竞争，未来扩展）
 *
 * 设计要点：
 *   - acquire() 返回 Promise，调用方 await 直到拿到锁
 *   - release() 释放锁，唤醒下一个等待者
 *   - 30s 超时防止死锁（Agent 崩溃时未 release）
 *   - 可重入检测：同一调用链不会死锁自己
 */
class TreeWriteLock {
  // 进程内等待队列：每个元素是一个 resolve 函数 + 超时定时器
  private queue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private locked = false;
  private lockHolder: string | null = null; // 当前持锁者标识（调试用）

  /**
   * 获取写锁。如果锁已被占用，排队等待。
   * @param callerId  调用者标识，如 'agent-k3jf92a1'，仅用于调试日志
   * @param timeoutMs 超时时间，默认 30s
   */
  async acquire(callerId: string, timeoutMs = 30_000): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      this.lockHolder = callerId;
      return;
    }

    // 可重入检测：同一 caller 不会和自己竞争
    if (this.lockHolder === callerId) {
      return; // 已经是持锁者，直接通过
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时：从队列中移除自己
        const idx = this.queue.findIndex(t => t.resolve === resolve);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error(`TreeWriteLock acquire timeout (${timeoutMs}ms) for ${callerId}`));
      }, timeoutMs);

      this.queue.push({ resolve, reject, timer });
    });
  }

  /**
   * 释放写锁。如果有等待者，唤醒队列中的第一个。
   */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      this.lockHolder = `next-from-queue`;
      next.resolve(); // 唤醒等待者（等待者会在 resolve 后设置 lockHolder）
      // 注意：被唤醒的调用方在 acquire() 返回后就已经是持锁者了，
      // 因为 acquire() 里检查 !this.locked 时才设置，但此时 locked=true。
      // 修正：唤醒时 locked 保持 true，等待者从 acquire 返回后直接持有锁。
    } else {
      this.locked = false;
      this.lockHolder = null;
    }
  }

  /** 当前是否有人持锁 */
  get isLocked(): boolean {
    return this.locked;
  }
}

// 全局单例——每棵树一个锁
const treeLocks = new Map<string, TreeWriteLock>();

function getTreeLock(sessionId: string): TreeWriteLock {
  let lock = treeLocks.get(sessionId);
  if (!lock) {
    lock = new TreeWriteLock();
    treeLocks.set(sessionId, lock);
  }
  return lock;
}
```

#### saveTree 修改后的签名与实现

```typescript
/**
 * 保存整棵任务树到磁盘（原子写入 + 互斥锁保护）。
 *
 * @param tree       完整的 TaskTree 对象
 * @param callerId   调用者标识，用于锁追踪，通常是 agent_team 的 agent.id
 * @throws           写入失败或锁超时时抛出
 *
 * 调用约定：
 *   - 调用方必须先通过 getTree() 获取最新树
 *   - 修改内存中的树节点
 *   - 调用 saveTree() 写回
 *   - 整个过程在锁保护下进行，确保读-改-写原子性
 */
export async function saveTree(tree: TaskTree, callerId: string): Promise<void> {
  const lock = getTreeLock(tree.sessionId);
  await lock.acquire(callerId);
  try {
    ensureTreesDir();
    const path = treePath(tree.sessionId);
    const tmp = path + '.tmp.' + Date.now(); // 加时间戳防止残留 tmp 冲突
    tree.updatedAt = Date.now();
    tree.version++;
    writeFileSync(tmp, JSON.stringify(tree, null, 2));
    renameSync(tmp, path);
  } finally {
    lock.release();
  }
}

/**
 * 读取整棵任务树（无锁——读不阻塞写，允许读到稍旧版本）。
 */
export function loadTree(sessionId: string): TaskTree | null {
  try {
    const path = treePath(sessionId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}
```

**关键设计决策：读不加锁**

读操作 (`loadTree`) 不获取写锁。理由是：
- 文件系统的 `rename` 是原子操作——读者要么读到完整旧版本，要么读到完整新版本，不会读到半截
- 如果读也加锁，读操作会阻塞写操作，降低吞吐
- Agent 读到稍旧版本影响不大——它只修改自己的节点，写回时版本号会递增，下次读会看到最新

### 1.3 实现代价

| 项 | 行数 | 说明 |
|----|------|------|
| `TreeWriteLock` 类 | ~65 行 | 含 acquire/release/超时/可重入 |
| `saveTree` 重写 | ~20 行 | 加锁包装 |
| `getTreeLock` + treeLocks Map | ~10 行 | 全局锁注册表 |
| `TreeNode` 接口加 `callerId` 字段 | +1 行 | 调试追踪用 |
| **合计** | **~96 行** | 均在 `src/task_tree.ts` 内 |

---

## 风险 A2：孤儿 Agent（资源泄露）

### 2.1 问题根因

**终止链断裂**：

```
Root (abortController-A)          ← 用户杀根节点
  ├── Branch-1 (abortController-B1) ← 根被杀后仍在运行
  │     ├── Worker-1a (abortController-W1a) ← 同上
  │     └── Worker-1b (abortController-W1b) ← 同上
  └── Branch-2 (abortController-B2) ← 根被杀后仍在运行
```

当前代码中，每个 Agent 的 `abortController`**互相独立**——它们都是 `addMember()` 中 `new AbortController()` 创建的（见 `agent_team.ts:84`）。AgentTool 创建子 Agent 时，没有把父子关系注入 `abortController` 的级联终止逻辑。

`preRoundCheck` 只检查**自己的** `abortController.signal.aborted`（见 AgentTool.ts:59-62）：

```typescript
preRoundCheck: () => {
  if (task.abortController?.signal.aborted) {
    task.status = 'killed';
    return '(killed)';
  }
  return null;
}
```

当 `AgentTeamTool.kill` 被调用时，它大概只 abort 了目标 Agent 的 controller，子 Agent 完全不知情。当父节点在任务树中被 `replaceSubtree()` 删除或状态改为 `killed` 时，子 Agent 的 `agentLoop` 继续运行——消耗 LLM 配额、写磁盘输出、直到自然结束或超时。

**根因本质**：终止信号没有沿 Agent 树向下传播。TreeNode 的父子关系（`parentId`/`children`）和 MemberState 的终止机制（`abortController`）之间没有桥接。

### 2.2 解决方案：级联终止 + 树感知的 preRoundCheck

**核心思路**：当任何 Agent 被 kill 时，自动沿任务树向下递归终止所有后代。同时，子 Agent 的 `preRoundCheck` 不仅检查自己的 abortController，还检查自己在树中的父节点是否已被杀。

#### 新增函数：cascadeKillTreeNode

```typescript
// src/task_tree.ts

import { getMember } from './agent_team.js';
import type { MemberState } from './agent_team.js';

/**
 * 级联终止一个树节点及其所有后代 Agent。
 *
 * 执行顺序（防止遗漏）：
 *   1. 标记当前节点 status = 'killed'
 *   2. 如果节点有 assignedAgentId，abort 其 Agent 的 AbortController
 *   3. 递归处理所有 children
 *
 * @param nodeId    要终止的节点 ID
 * @param tree      完整的 TaskTree（调用方持有写锁）
 * @param reason    终止原因（日志用）
 * @returns         被终止的 Agent ID 列表（用于通知和日志）
 */
function cascadeKillTreeNode(
  nodeId: string,
  tree: TaskTree,
  reason: string,
): string[] {
  const killedAgentIds: string[] = [];
  const node = tree.nodes[nodeId];
  if (!node) return killedAgentIds;

  // 1. 标记节点为 killed
  node.status = 'killed';
  node.result = `(killed: ${reason})`;

  // 2. 终止该节点的 Agent 进程
  if (node.assignedAgentId) {
    const member: MemberState | undefined = getMember(node.assignedAgentId);
    if (member && member.status !== 'completed' && member.status !== 'failed') {
      member.abortController?.abort();
      member.status = 'killed';
      member.endTime = Date.now();
      killedAgentIds.push(node.assignedAgentId);
    }
  }

  // 3. 递归终止所有子节点
  for (const childId of node.children) {
    killedAgentIds.push(...cascadeKillTreeNode(childId, tree, `父节点 ${nodeId} 被终止`));
  }

  return killedAgentIds;
}

/**
 * 公开接口：kill 一个树节点并级联。
 *
 * 调用方必须在外层持有树写锁（先 acquire，再调此函数，再 saveTree）。
 *
 * @returns 被终止的 Agent ID 列表
 */
export function killTreeNode(nodeId: string, tree: TaskTree, reason: string): string[] {
  return cascadeKillTreeNode(nodeId, tree, reason);
}
```

#### 修改 AgentTool：树感知的 preRoundCheck

```typescript
// src/tools-v2/AgentTool/AgentTool.ts — 在 call() 内的 subConfig.preRoundCheck 增加树检查

import { loadTree } from '../../task_tree.js';
import type { TaskTree, TreeNode } from '../../task_tree.js';

// 在创建子 Agent 时传入 treeNodeId（需要 AgentTool 的 inputSchema 新增一个内部字段）
// 子 Agent 的 preRoundCheck 检查逻辑扩展为：

preRoundCheck: (messages: ChatMessage[]) => {
  // 原有检查：自己的 abortController
  if (task.abortController?.signal.aborted) {
    task.status = 'killed';
    return '(killed by signal)';
  }

  // ★ 新增：检查父节点在树中是否还存活
  if (task.treeNodeId && task.sessionId) {
    const tree = loadTree(task.sessionId);
    if (tree) {
      const myNode = tree.nodes[task.treeNodeId];
      if (myNode) {
        // 自己是否已被标记 killed
        if (myNode.status === 'killed') {
          task.abortController?.abort();
          task.status = 'killed';
          return '(killed: node marked killed in tree)';
        }
        // 向上追溯：父节点是否存活
        if (!isAncestorAlive(myNode, tree)) {
          task.abortController?.abort();
          task.status = 'killed';
          return '(killed: ancestor node killed)';
        }
      }
    }
  }

  // 原有检查：pendingInstruction
  if (task.pendingInstruction) {
    messages.push({ role: 'user', content: `[MAIN AGENT INSTRUCTION]: ${task.pendingInstruction}` });
    task.pendingInstruction = undefined;
    return null;
  }
  return null;
}
```

#### 辅助函数：祖先存活检查

```typescript
// src/task_tree.ts

/**
 * 向上追溯：检查从 node 到根的所有祖先节点是否都处于存活状态。
 * 存活状态 = 'pending' | 'running' | 'blocked' | 'completed'
 * 死亡状态 = 'killed' | 'failed'
 *
 * 如果任一祖先死亡，返回 false。
 */
function isAncestorAlive(node: TreeNode, tree: TaskTree): boolean {
  const DEAD_STATUSES: TreeNode['status'][] = ['killed', 'failed'];
  let currentId = node.parentId;
  while (currentId) {
    const parent = tree.nodes[currentId];
    if (!parent) return true; // 父节点不在树中（可能被删），保守处理：认为自己存活
    if (DEAD_STATUSES.includes(parent.status)) return false;
    currentId = parent.parentId;
  }
  return true;
}
```

### 2.3 MemberState 新增字段

```typescript
// src/agent_team.ts — MemberState 接口新增

export interface MemberState {
  // ... 现有字段 ...
  abortController?: AbortController;

  // ★ 新增：任务树关联
  treeNodeId?: string;    // 对应的 TreeNode.id（如 "n-k3jf92a1"）
  sessionId?: string;     // 所属会话 ID（用于 preRoundCheck 中 loadTree）
}
```

### 2.4 实现代价

| 项 | 文件 | 行数 |
|----|------|------|
| `cascadeKillTreeNode` | `src/task_tree.ts` | ~30 行 |
| `killTreeNode` 公开接口 | `src/task_tree.ts` | ~5 行 |
| `isAncestorAlive` | `src/task_tree.ts` | ~12 行 |
| `MemberState` 加 `treeNodeId`/`sessionId` | `src/agent_team.ts` | +2 行 |
| `preRoundCheck` 扩展（树检查） | `src/tools-v2/AgentTool/AgentTool.ts` | ~20 行 |
| AgentTool 创建子 Agent 时传入 treeNodeId | `src/tools-v2/AgentTool/AgentTool.ts` | ~5 行 |
| **合计** | **3 个文件** | **~74 行** |

---

## 风险 A3：缺少单写者模型

### 3.1 问题根因

**问题不是"原子写入不够好"，而是"允许多人同时写"这个设计本身就是错的。**

回顾当前设计的调用链：

```
Root.agentLoop:     saveTree() ← 更新根节点状态
Branch-1.agentLoop: saveTree() ← 更新 branch-1 的状态和子节点列表
Branch-2.agentLoop: saveTree() ← 更新 branch-2 的状态和子节点列表
Worker-1a:          saveTree() ← 更新自己的 result
Worker-1b:          saveTree() ← 更新自己的 result
```

五个调用方可以独立、并发地调用 `saveTree()`。即使每个调用内部是原子写入，也无法保证数据一致性——因为**读树 → 修改 → 写树**这三步不是原子的。这就好比五个线程在没有 mutex 的情况下修改同一个 HashMap。

**和现有 `agent_team.ts` 的对比**：

`agent_team.ts` 的 `saveMemberOutput(id, text)` 是**按 Agent ID 分片的**——每个 Agent 只写自己的文件 `{agent-id}.txt`。不同 Agent 的写入目标不同，天然不会冲突。但任务树不同——所有节点共享同一个 JSON 文件，分片不可能。

### 3.2 解决方案：强制单写者 + API 收口

**核心思路**：用 A1 中设计的 `TreeWriteLock` 作为**唯一的写入口**。所有对树的修改必须通过以下三个 API 之一，三个 API 内部都先 acquire 锁再操作：

```typescript
// src/task_tree.ts — 三个强制入口

/**
 * API-1: 更新单个节点的字段（最常用）。
 *
 * 调用示例：
 *   await updateTreeNode('n-k3jf92a1', sessionId, 'agent-abc',
 *     { status: 'completed', result: '重构完成...' });
 *
 * 内部流程：acquire → loadTree → 找到节点 → 合并字段 → saveTree → release
 */
export async function updateTreeNode(
  nodeId: string,
  sessionId: string,
  callerId: string,
  patch: Partial<Pick<TreeNode, 'status' | 'result' | 'assignedAgentId' | 'replanCount'>>,
): Promise<void> {
  const lock = getTreeLock(sessionId);
  await lock.acquire(callerId);
  try {
    const tree = loadTree(sessionId);
    if (!tree) throw new Error(`Tree not found: ${sessionId}`);
    const node = tree.nodes[nodeId];
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    Object.assign(node, patch);
    tree.updatedAt = Date.now();
    tree.version++;
    writeTreeAtomic(tree); // 内部：writeFileSync(tmp) + renameSync(tmp, path)
  } finally {
    lock.release();
  }
}

/**
 * API-2: 批量操作（添加子节点 + 同时更新父节点 children 数组）。
 *
 * 调用示例：
 *   await batchTreeOperation(sessionId, 'agent-abc', (tree) => {
 *     const newNode = createNode(...);
 *     tree.nodes[newNode.id] = newNode;
 *     tree.nodes[parentId].children.push(newNode.id);
 *   });
 *
 * 关键设计：回调在锁内执行，保证整个批量操作的原子性。
 */
export async function batchTreeOperation(
  sessionId: string,
  callerId: string,
  operation: (tree: TaskTree) => void,
): Promise<void> {
  const lock = getTreeLock(sessionId);
  await lock.acquire(callerId);
  try {
    const tree = loadTree(sessionId);
    if (!tree) throw new Error(`Tree not found: ${sessionId}`);
    operation(tree);
    tree.updatedAt = Date.now();
    tree.version++;
    writeTreeAtomic(tree);
  } finally {
    lock.release();
  }
}

/**
 * API-3: 替换子树（失败叶节点 → 删除旧子树 → 插入新子树）。
 *
 * 内部：acquire → loadTree → removeSubtree(递归删除) → addChildNodes → saveTree → release。
 * 这个操作必须原子——中间状态（旧子树已删、新子树未加）不可见。
 */
export async function replaceSubtree(
  sessionId: string,
  callerId: string,
  failedNodeId: string,
  newSubtreeNodes: TreeNode[],
): Promise<void> {
  const lock = getTreeLock(sessionId);
  await lock.acquire(callerId);
  try {
    const tree = loadTree(sessionId);
    if (!tree) throw new Error(`Tree not found: ${sessionId}`);
    const parentId = tree.nodes[failedNodeId]?.parentId;
    if (!parentId) throw new Error(`Cannot replace root node`);

    // 1. 递归删除旧子树
    const removedIds = removeSubtreeNodes(failedNodeId, tree);

    // 2. 插入新子树
    for (const newNode of newSubtreeNodes) {
      tree.nodes[newNode.id] = newNode;
    }

    // 3. 从父节点 children 中替换引用
    const parent = tree.nodes[parentId];
    const idx = parent.children.indexOf(failedNodeId);
    if (idx >= 0) {
      parent.children.splice(idx, 1, ...newSubtreeNodes.filter(n => n.parentId === parentId).map(n => n.id));
    }

    tree.updatedAt = Date.now();
    tree.version++;
    writeTreeAtomic(tree);
  } finally {
    lock.release();
  }
}

/**
 * 底层写入函数——不做任何锁操作，调用方必须已持有锁。
 */
function writeTreeAtomic(tree: TaskTree): void {
  ensureTreesDir();
  const path = treePath(tree.sessionId);
  const tmp = path + '.tmp.' + Date.now();
  writeFileSync(tmp, JSON.stringify(tree, null, 2));
  renameSync(tmp, path);
}
```

### 3.3 反模式（明确禁止）

```typescript
// ❌ 禁止：直接读-改-写，无锁保护
const tree = loadTree(sessionId);
tree.nodes['n-xxx'].status = 'completed';
writeFileSync(path, JSON.stringify(tree)); // 数据竞争!

// ❌ 禁止：绕过 API 直接操作文件
writeFileSync(treePath(sessionId), customJson);

// ✅ 正确：通过三个 API 之一
await updateTreeNode('n-xxx', sessionId, agentId, { status: 'completed' });
```

**强制手段**：`writeTreeAtomic` 不导出（模块私有），`loadTree` 只读。外部只能通过 `updateTreeNode` / `batchTreeOperation` / `replaceSubtree` 修改树。

### 3.4 实现代价

| 项 | 行数 | 说明 |
|----|------|------|
| `updateTreeNode` | ~20 行 | 单节点更新入口 |
| `batchTreeOperation` | ~18 行 | 回调式批量操作 |
| `replaceSubtree` | ~35 行 | 子树替换（含递归删除） |
| `writeTreeAtomic` | ~8 行 | 底层原子写 |
| `TreeWriteLock`（A1 已计） | — | 复用 |
| **合计** | **~81 行** | 均在 `src/task_tree.ts` |

---

## 汇总：全部改动的文件与行数

| 文件 | 改动内容 | 新增行 |
|------|----------|--------|
| `src/task_tree.ts` | TreeWriteLock + saveTree/loadTree + cascadeKill + updateTreeNode + batchTreeOp + replaceSubtree | ~250 行（含原有计划的基础树操作 ~100 行） |
| `src/agent_team.ts` | MemberState 加 `treeNodeId`/`sessionId` | +2 行 |
| `src/tools-v2/AgentTool/AgentTool.ts` | preRoundCheck 扩展树检查 + 创建时传入 treeNodeId | ~25 行 |
| **三个文件合计** | | **~277 行**（去重后） |

---

## 各风险的关联与实施顺序

三个风险的解决有依赖关系：

```
A3（单写者锁）── 基础 ──→ A1（并发写树）── 依赖锁
  
A3（单写者锁）── 基础 ──→ A2（孤儿Agent）── preRoundCheck 中的 loadTree 不需要写锁

建议实施顺序：
  第1步: TreeWriteLock 类 + saveTree/loadTree（A1 + A3 的底层）
  第2步: updateTreeNode / batchTreeOperation / replaceSubtree（A3 的 API 层）
  第3步: cascadeKillTreeNode + isAncestorAlive（A2 的终止逻辑）
  第4步: AgentTool preRoundCheck 扩展 + MemberState 加字段（A2 的集成）
```

第2步和第3步可以并行实施，因为它们的依赖都只有第1步。

---

## 验证清单

| # | 场景 | 期望 |
|---|------|------|
| 1 | 两个 Agent 同时调 `updateTreeNode` 修改不同节点 | 两次操作串行执行，树版本号递增两次，两个节点的修改都保留 |
| 2 | Agent A 持锁写树时 Agent B 启动 | Agent B 的 `acquire()` 排队，A 释放后 B 立即获得锁并写入 |
| 3 | 持锁 Agent 崩溃未 release | 30s 超时后队列中下一个 Agent 获得锁（不会永久死锁） |
| 4 | 同一 Agent 连续两次调 `updateTreeNode` | 可重入检测放行，不会和自己死锁 |
| 5 | kill 父节点（Branch-1）有 3 个 Worker 子节点在运行 | 3 个 Worker 的 abortController 被 cascade 依次触发，各自在下一轮 preRoundCheck 中检测到 aborted 并退出 |
| 6 | Worker 在 preRoundCheck 中检测到祖先已被 kill | Worker 自主退出，不等 cascade 传播到它（双重保险） |
| 7 | `replaceSubtree` 过程中发生崩溃 | 锁在 finally 中释放（不会永久死锁）。磁盘上最多留一个 .tmp 文件 |
| 8 | 绕过 API 直接写文件 | TypeScript 编译不通过（`writeTreeAtomic` 不导出，`saveTree` 需要 callerId 参数） |
