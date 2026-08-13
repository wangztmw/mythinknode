# 任务树系统 — 上下文膨胀 / 存储开销 / 引用完整性 解决方案

> **日期**：2026-08-06
> **基于**：`plan-task-tree.md` 的 TreeNode/TaskTree 设计
> **关联文件**：`src/agent_team.ts` (MemberState), `src/session_loop.ts` (agentLoop)

---

## 第一部分：上下文膨胀控制（风险 #8）

### 问题分析

`agentLoop()` 的 `preRoundCheck` 硬悬每到回合就咬一口树状态。每个 TreeNode 至少 12 个字段约 150-300 token。一棵 20 节点的树全量检查 = 3000-6000 token/轮，30 轮就是 90K-180K token 纯元数据开销。根 Agent 的 `messages[]` 数组 (session_loop.ts:109) 无界增长，已在 real-session.json 中观测到 169KB 的上下文膨胀。

**根因**：没有分层信息压缩。根 Agent 看到所有叶节点细节，而它只需要摘要做决策。

### 方案 A1：叶节点结果长度限制

**规则**：`role === 'worker'` 的叶节点 Agent 必须把结果压缩在 **300 词以内**。

**实施位置**（三处同时）：

| 位置 | 手段 | 代码 |
|------|------|------|
| Worker 的 system prompt | `agent_def.ts` 注入约束 | `"Your final report MUST be under 300 words. Use bullet points. Omit tool logs."` |
| `completeMember()` 内存摘要 | `agent_team.ts:91-99` | `m.output = output.slice(0, 500)` 已是 500 字符，改为 300 词截断 |
| `reportResult()` 写入树前 | `task_tree.ts` 新函数 | `truncateToWordLimit(output, 300)` |

```typescript
// 新增: task_tree.ts
function truncateToWordLimit(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + ' (truncated)';
}

export function setNodeResult(tree: TaskTree, nodeId: string, raw: string): void {
  const node = tree.nodes[nodeId];
  if (!node) return;
  // Worker 叶节点强制截断，Planner/Supervisor 允许更长
  if (node.role === 'worker') {
    node.result = truncateToWordLimit(raw, 300);
  } else {
    node.result = raw.slice(0, 2000); // 分支摘要上限 2000 字符
  }
  tree.updatedAt = Date.now();
  tree.version++;
}
```

**效果**：叶节点结果从无限制（可达数千词）降到 <=300 词。20 个叶节点全展开 = 最多 6000 词 vs 之前的无上限。

### 方案 A2：层次化摘要

根 Agent 永远不直接读叶节点结果。树枝 Agent (supervisor) 汇总其子节点后向上汇报摘要。

```
         Root (planner)
           ↑ 只看到树枝摘要
    ┌──────┴────────┐
Branch A          Branch B       ← supervisor 角色
  ↑ 摘要            ↑ 摘要
Leaf1 Leaf2        Leaf3 Leaf4   ← worker 角色，300词结果
```

**实施**：`checkSubtreeStatus()` 根据调用者深度返回不同粒度。

```typescript
// task_tree.ts 新增
export function summarizeSubtree(
  tree: TaskTree,
  nodeId: string,
  depth: 'branch' | 'leaf' | 'all'
): string {
  const node = tree.nodes[nodeId];
  if (!node) return '';

  if (depth === 'leaf' || node.children.length === 0) {
    // 叶节点：返回状态 + 结果摘要（1 行）
    return formatNodeLine(node);
  }

  // 分支节点：收集所有子节点摘要
  const childLines = node.children.map(cid =>
    summarizeSubtree(tree, cid, getDepthFor(node.role))
  );

  // supervisor 在此做二次压缩
  if (node.role === 'supervisor') {
    return [
      formatNodeLine(node),
      `  ${childLines.length} children: ${countByStatus(childLines)}`,
      ...childLines.map(l => `  ${l}`)
    ].join('\n');
  }

  return [formatNodeLine(node), ...childLines.map(l => `  ${l}`)].join('\n');
}

// 辅助：每节点单行格式（约 15-20 token/节点）
function formatNodeLine(node: TreeNode): string {
  const icon = { pending:'◌', running:'●', completed:'✓', failed:'✗', blocked:'⊘', killed:'☠' }[node.status];
  const age = node.result ? ` (${node.result.slice(0, 50)})` : '';
  return `${icon} ${node.meaning}${age}`;
}

function countByStatus(lines: string[]): string {
  // 统计各状态数量 → "3 done, 1 running, 2 pending"
  // 实现略
}
```

**效果**：根 Agent 看到 5 行（1 行总览 + 4 行树枝摘要）而非 20+ 行叶节点细节。消息规模缩小 80%。

### 方案 A3：状态检查分级

`AgentTeam(list)` 和 `AgentTeam(check)` 回归同工具的不同输出：

| 调用 | 返回内容 | token 预算 | 使用场景 |
|------|---------|-----------|---------|
| `AgentTeam(list)` | 每节点 1 行，纯状态 | ~20 token/节点 | 每轮 preRoundCheck |
| `AgentTeam(check, nodeId)` | 单节点完整状态 + 结果 + 子节点状态 | ~200 token | LLM 主动请求详情 |
| `AgentTeam(check, nodeId, deep)` | 整棵子树完整展开 | ~300 token/节点 | 调试 / 失败排查 |

**实施**（AgentTeam 工具内部）：

```typescript
// AgentTool.ts 内部，解析 subagent_type 参数
function handleTeamCommand(params: {
  action: 'list' | 'check';
  nodeId?: string;
  deep?: boolean;
  treeId: string;
}): string {
  const tree = loadTree(params.treeId);
  if (!tree) return 'No active tree.';

  switch (params.action) {
    case 'list':
      // 紧凑模式：每节点一行，只含 status 和 meaning
      return Object.values(tree.nodes)
        .map(n => `${statusIcon(n.status)} ${n.meaning}`)
        .join('\n');
    case 'check':
      if (params.nodeId) {
        const node = tree.nodes[params.nodeId];
        if (!node) return `Node ${params.nodeId} not found.`;
        if (params.deep) return summarizeSubtree(tree, params.nodeId, 'all');
        return `${formatNodeLine(node)}\n  result: ${node.result || '(none)'}\n  children: ${node.children.map(c => tree.nodes[c]?.status || '?').join(', ')}`;
      }
      // 无 nodeId: 返回根节点完整状态
      return summarizeSubtree(tree, tree.rootId, 'all');
  }
}
```

**效果**：日常 `list` 模式下 20 节点树只消 400 token（20 token × 20），而非之前的 6000 token。仅 LLM 主动询问时才展开详细信息。

### 方案 A4：延迟加载（Lazy Loading）

根 Agent 启动时不把整棵树塞入上下文。只在需要时分片段加载。

**实施**：不在 system prompt 或 preRoundCheck 中注入全树。改为：

```typescript
// session_loop.ts 的 preRoundCheck 修改
function treePreRoundCheck(treeId: string): (msgs: ChatMessage[]) => string | null {
  return (msgs) => {
    const tree = loadTree(treeId);
    if (!tree) return null;

    // 不再返回全量树状态
    // 只检查：有没有节点需要 Root 决策？
    //   - 所有子节点都 completed？ → "All branches done. Review results."
    //   - 有节点 failed？ → "Branch X failed. Needs replan."
    //   - 有节点 blocked？ → "Branch Y blocked: Z. Needs unblock."
    //   - 否则 → null (不注入任何上下文)
    const decision = checkIfRootNeeded(tree);
    if (decision) return `[TREE] ${decision}`;
    return null; // 无决策需要 → 不污染上下文
  };
}
```

**效果**：大部分回合不注入任何树上下文。只在异常/完成时才推动根 Agent 做决策。从每轮 500-1000 token 降到 0 token（正常流程）。

---

## 第二部分：存储管理（风险 #17）

### 问题分析

`plan-task-tree.md` 的存储设计：原子写入到 `~/.mycoder/trees/{session-id}.json`。没有大小限制、没有清理机制、没有增量写入。一个中等复杂任务 30 节点的树 JSON 约 15-25KB。长期运行多会话会堆积。`agent_team.ts` 已有 `cleanOldMembers()` 清理 7 天前的团队文件，但树文件完全没有类似机制。

### 方案 B1：文件大小限制 + 归档

```typescript
// task_tree.ts 新增
const MAX_TREE_SIZE = 100 * 1024; // 100KB
const TREE_DIR = join(homedir(), '.mycoder', 'trees');
const ARCHIVE_DIR = join(TREE_DIR, 'archive');

function ensureDirs(): void {
  if (!existsSync(TREE_DIR)) mkdirSync(TREE_DIR, { recursive: true });
  if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });
}

export function saveTree(tree: TaskTree): void {
  ensureDirs();
  const path = join(TREE_DIR, `${tree.sessionId}.json`);
  const tmp = path + '.tmp';
  const data = JSON.stringify(tree, null, 2);

  // 大小检查
  if (Buffer.byteLength(data) > MAX_TREE_SIZE) {
    // 归档当前版本 → 只保留精简状态（去掉 result 中的长文本）
    archiveTree(tree);
    const compact = compactTree(tree);
    const compactData = JSON.stringify(compact, null, 2);
    writeFileSync(tmp, compactData);
    renameSync(tmp, path);
    return;
  }

  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function compactTree(tree: TaskTree): TaskTree {
  // 保留结构但压缩结果字段
  const compact: TaskTree = {
    ...tree,
    nodes: {}
  };
  for (const [id, node] of Object.entries(tree.nodes)) {
    compact.nodes[id] = {
      ...node,
      result: node.result
        ? node.result.slice(0, 200) + (node.result.length > 200 ? '...' : '')
        : null
    };
  }
  return compact;
}

function archiveTree(tree: TaskTree): void {
  const archivePath = join(ARCHIVE_DIR,
    `${tree.sessionId}-v${tree.version}-${Date.now()}.json`);
  writeFileSync(archivePath, JSON.stringify(tree, null, 2));
}
```

**效果**：主树文件永远 <= 100KB。历史版本归档但不阻塞当前操作。

### 方案 B2：自动清理

镜像 `agent_team.ts:64-73` 的 `cleanOldMembers()` 模式：

```typescript
// task_tree.ts 新增
const TREE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

export function cleanOldTrees(): void {
  try {
    if (!existsSync(TREE_DIR)) return;
    const cutoff = Date.now() - TREE_MAX_AGE_MS;

    // 清理主树文件
    for (const f of readdirSync(TREE_DIR)) {
      if (!f.endsWith('.json')) continue;
      const p = join(TREE_DIR, f);
      try {
        const stat = statSync(p);
        if (stat.mtimeMs < cutoff) unlinkSync(p);
      } catch { /* skip */ }
    }

    // 清理归档
    if (existsSync(ARCHIVE_DIR)) {
      for (const f of readdirSync(ARCHIVE_DIR)) {
        const p = join(ARCHIVE_DIR, f);
        try {
          if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
        } catch { /* skip */ }
      }
    }
  } catch { /* 静默 */ }
}
```

**调用时机**：`session.ts` 启动时同时调用 `cleanOldMembers()` 和 `cleanOldTrees()`。

```typescript
// session.ts 启动流程补充
import { cleanOldTrees } from './task_tree.js';
import { cleanOldMembers } from './agent_team.js';

export function startSession() {
  cleanOldMembers(); // 已有
  cleanOldTrees();   // 新增
  // ...
}
```

### 方案 B3：节点数量上限

```typescript
const MAX_NODES_PER_TREE = 50;

export function addChildNode(
  tree: TaskTree,
  parentId: string,
  node: Omit<TreeNode, 'id' | 'parentId' | 'depth' | 'children'>
): TreeNode | null {
  const parent = tree.nodes[parentId];
  if (!parent) return null;

  // 数量检查
  if (Object.keys(tree.nodes).length >= MAX_NODES_PER_TREE) {
    // 超过 50 节点 → LLM 分解过度
    // 写 warning 日志，拒绝添加，提示用户简化任务
    console.warn(
      `Task tree reached ${MAX_NODES_PER_TREE} node limit. ` +
      `The task may be over-decomposed. Consider simplifying.`
    );
    return null;
  }

  const id = 'n-' + Math.random().toString(36).slice(2, 10);
  const newNode: TreeNode = {
    ...node,
    id,
    parentId,
    depth: parent.depth + 1,
    children: [],
    status: 'pending',
    result: null,
    replanCount: 0,
  };
  tree.nodes[id] = newNode;
  parent.children.push(id);
  tree.updatedAt = Date.now();
  tree.version++;
  return newNode;
}
```

**上限选择的理由**：50 节点对应一棵 height=3 的 4-5 叉树。`plan-task-tree.md` 的 depth 设计是 0/1/2（root/branch/leaf）。root 有 5 个 branch，每个 branch 有 4-5 个 leaf = 约 25-30 节点。50 已留充足余量。超过此数说明 LLM 在不受控地创建微观任务，应由人类介入。

### 方案 B4：增量写入（Delta）

全量 JSON 重写每次修改都 O(n)。改为只写变化的部分：

```typescript
// task_tree.ts 新增
interface TreeDelta {
  sessionId: string;
  version: number;       // 基于哪个版本
  nodeUpdates: Partial<TreeNode>[];  // 只含变化的字段
  nodeDeletions: string[];           // 被删除的节点 ID
}

const DELTA_DIR = join(TREE_DIR, 'deltas');

export function writeDelta(tree: TaskTree, delta: TreeDelta): void {
  ensureDirs();
  const deltaPath = join(DELTA_DIR,
    `${tree.sessionId}-v${delta.version}-${Date.now()}.json`);
  writeFileSync(deltaPath, JSON.stringify(delta));

  // 每 10 个 delta 做一次全量快照 (compaction)
  const existingDeltas = readdirSync(DELTA_DIR)
    .filter(f => f.startsWith(tree.sessionId)).length;
  if (existingDeltas >= 10) {
    saveTree(tree); // 全量写入
    // 删除旧 delta
    for (const f of readdirSync(DELTA_DIR)) {
      if (f.startsWith(tree.sessionId)) unlinkSync(join(DELTA_DIR, f));
    }
  }
}

export function loadTree(sessionId: string): TaskTree | null {
  const basePath = join(TREE_DIR, `${sessionId}.json`);
  try {
    const tree: TaskTree = JSON.parse(readFileSync(basePath, 'utf-8'));

    // 回放后续 delta
    if (existsSync(DELTA_DIR)) {
      const deltas = readdirSync(DELTA_DIR)
        .filter(f => f.startsWith(sessionId) && f.endsWith('.json'))
        .sort(); // 按时间排序
      for (const df of deltas) {
        const delta: TreeDelta = JSON.parse(
          readFileSync(join(DELTA_DIR, df), 'utf-8')
        );
        if (delta.version > tree.version) {
          applyDelta(tree, delta);
        }
      }
    }
    return tree;
  } catch {
    return null;
  }
}

function applyDelta(tree: TaskTree, delta: TreeDelta): void {
  for (const update of delta.nodeUpdates) {
    const node = tree.nodes[update.id!];
    if (node) Object.assign(node, update);
  }
  for (const id of delta.nodeDeletions) {
    const node = tree.nodes[id];
    if (node?.parentId) {
      const parent = tree.nodes[node.parentId];
      if (parent) parent.children = parent.children.filter(c => c !== id);
    }
    delete tree.nodes[id];
  }
  tree.version = delta.version;
}
```

**效果**：大部分树修改（status 更新、单节点 result 写入）只用写 200-500 字节的 delta 而非 20KB+ 的全量 JSON。减少 I/O 并降低并发写入冲突概率。

---

## 第三部分：引用完整性（风险 #20）

### 问题分析

`TreeNode.assignedAgentId` (plan-task-tree.md:100) 是单向引用：树指向 Agent。当 Agent 生命周期结束（完成/失败/被 kill），`assignedAgentId` 变成悬空指针。`plan-task-tree.md:131` 计划在 `MemberState` 加 `treeNodeId` 做反向链接，但这只是多了另一个可能变脏的指针。真正需要的是**验证 + 修复机制**。

### 方案 C1：状态检查时验证引用

每次 `checkSubtreeStatus()` 或渲染树时，验证所有 `assignedAgentId`：

```typescript
// task_tree.ts 新增
import { getMember } from './agent_team.js';

export interface ReferenceCheck {
  valid: number;
  stale: string[];    // agent 已不存在的节点 ID 列表
  orphaned: string[];  // 有 agent 但 agent 状态不匹配的节点
}

export function validateReferences(tree: TaskTree): ReferenceCheck {
  const result: ReferenceCheck = { valid: 0, stale: [], orphaned: [] };

  for (const [id, node] of Object.entries(tree.nodes)) {
    if (!node.assignedAgentId) {
      // 没有 agent 分配 → 跳过（pending 或 completed 未分配）
      continue;
    }

    const member = getMember(node.assignedAgentId);
    if (!member) {
      // Agent 已死 → 引用断裂
      result.stale.push(id);
      continue;
    }

    // Agent 存在但状态不匹配
    if (node.status === 'running' && member.status === 'completed') {
      result.orphaned.push(id);
    }
    if (node.status === 'running' && member.status === 'failed') {
      result.orphaned.push(id);
    }

    result.valid++;
  }

  return result;
}
```

### 方案 C2：自动修复断裂引用

`validateReferences` 发现问题后不沉默，而是自动修复：

```typescript
export function repairStaleReferences(tree: TaskTree): number {
  const check = validateReferences(tree);
  let repaired = 0;

  for (const nodeId of check.stale) {
    const node = tree.nodes[nodeId];
    if (!node) continue;

    // 策略 1：如果节点有 result 字段且状态是 running → 标记 failed
    if (node.status === 'running') {
      node.status = 'failed';
      node.result = node.result || '(agent lost — result unknown)';
      node.assignedAgentId = null;
      repaired++;
    }

    // 策略 2：如果节点没有 result → 标记 orphaned（父节点需重新规划）
    if (node.status === 'pending') {
      node.status = 'failed';
      node.result = '(agent was never assigned)';
      node.assignedAgentId = null;
      repaired++;
    }
  }

  for (const nodeId of check.orphaned) {
    const node = tree.nodes[nodeId];
    if (!node || !node.assignedAgentId) continue;
    const member = getMember(node.assignedAgentId);
    if (!member) continue;

    // 同步 agent 状态到节点
    node.status = mapMemberStatusToNodeStatus(member.status);
    if (member.status === 'completed' && member.output) {
      node.result = member.output.slice(0, 2000);
    }
    repaired++;
  }

  if (repaired > 0) {
    tree.updatedAt = Date.now();
    tree.version++;
  }
  return repaired;
}

function mapMemberStatusToNodeStatus(ms: MemberStatus): TreeNode['status'] {
  const map: Record<MemberStatus, TreeNode['status']> = {
    pending: 'pending',
    running: 'running',
    blocked: 'blocked',
    completed: 'completed',
    failed: 'failed',
    killed: 'killed',
  };
  return map[ms];
}
```

### 方案 C3：双向链接 + 生命周期钩子

按照 `plan-task-tree.md:131` 的设计给 `MemberState` 加 `treeNodeId`。但这不是为了"多一个引用"，而是为了让 Agent 生命周期事件自动同步树状态：

```typescript
// agent_team.ts — MemberState 扩展（按 plan 的 3 行修改）
export interface MemberState {
  // ... 现有字段
  treeNodeId?: string;   // 反向链接到 TreeNode.id (新增)
  treeRole?: 'planner' | 'supervisor' | 'worker';  // (新增)
  treeDepth?: number;    // (新增)
}

// agent_team.ts — completeMember 增强版
export function completeMember(id: string, output: string) {
  const m = team.get(id);
  if (m) {
    m.status = 'completed';
    m.endTime = Date.now();
    m.output = output.slice(0, 500);
    m.outputOffset = output.length;
    saveMemberOutput(id, output);

    // ★ 自动同步树节点
    if (m.treeNodeId) {
      // 懒加载 task_tree 模块，避免循环依赖
      const { syncNodeFromMember } = require('./task_tree.js');
      syncNodeFromMember(m.treeNodeId, 'completed', output.slice(0, 300));
    }
  }
}

// 同样要在 failMember, killMember 中加入同步逻辑
```

**task_tree.ts 对应函数**：

```typescript
// 循环依赖处理：agent_team → task_tree 通过延迟导入
export function syncNodeFromMember(
  treeNodeId: string,
  status: TreeNode['status'],
  result?: string
): void {
  // 需要在 tree registry 中查找包含此节点的树
  // 或者在 TreeNode 中反向存 treeId
  // 这里用简化方案：全局 active tree 引用
  const tree = getActiveTree();
  if (!tree) return;
  const node = tree.nodes[treeNodeId];
  if (!node) return;
  node.status = status;
  if (result) node.result = result;
  tree.updatedAt = Date.now();
  tree.version++;
}
```

### 方案 C4：启动时全量验证

在 session 启动时检查所有 persistent tree 文件的引用完整性：

```typescript
// session.ts 启动流程补充
export function validateAllTreesOnStartup(): void {
  const treeDir = join(homedir(), '.mycoder', 'trees');
  if (!existsSync(treeDir)) return;

  for (const f of readdirSync(treeDir)) {
    if (!f.endsWith('.json')) continue;
    const treePath = join(treeDir, f);
    try {
      const tree: TaskTree = JSON.parse(readFileSync(treePath, 'utf-8'));
      const repaired = repairStaleReferences(tree);
      if (repaired > 0) {
        console.warn(
          `[tree] Repaired ${repaired} stale references in ${f}`
        );
        saveTree(tree); // 写回修复后的树
      }
    } catch {
      // 损坏的 JSON → 移到 archive 或删除
      console.warn(`[tree] Corrupted tree file: ${f}, archiving`);
      const archivedPath = join(treeDir, 'archive', f);
      renameSync(treePath, archivedPath);
    }
  }
}

// 注册到 session 启动
export function startSession() {
  cleanOldMembers();
  cleanOldTrees();
  validateAllTreesOnStartup(); // 新增
  // ...
}
```

---

## 实施优先级

| 优先级 | 方案 | 改动量 | 影响范围 | 独立可测 |
|--------|------|--------|---------|---------|
| **P0 立即** | A1 叶节点 300 词限制 | +10 行 task_tree.ts +3 行 agent_def.ts | 防止上下文爆炸 | 是 |
| **P0 立即** | A3 状态检查分级 | +30 行 AgentTool.ts | 减少每轮 token | 是 |
| **P0 立即** | C1 引用验证 | +25 行 task_tree.ts | 防止悬空指针 | 是 |
| **P1 本周** | A4 延迟加载 | +20 行 session_loop.ts | 大幅减少被动上下文 | 是 |
| **P1 本周** | B2 自动清理 | +25 行 task_tree.ts | 防止磁盘堆积 | 是 |
| **P1 本周** | B3 50 节点上限 | +8 行 task_tree.ts | 防止过度分解 | 是 |
| **P2 下迭代** | A2 层次化摘要 | +40 行 task_tree.ts | 上下文结构优化 | 部分 (需 supervisor agent 配合) |
| **P2 下迭代** | B1 大小限制+归档 | +35 行 task_tree.ts | 长期稳定 | 是 |
| **P2 下迭代** | C2/C3/C4 自动修复+双向链接+启动验证 | +50 行 task_tree.ts +10 行 agent_team.ts | 引用完整性闭环 | 否 (需三个联动) |
| **P3 优化** | B4 增量写入 | +60 行 task_tree.ts | 写入性能 | 是 |

---

## 不做的方案

| 方案 | 原因 |
|------|------|
| 树数据放数据库 (SQLite) | 引入新依赖，与当前文件系统模式不一致 |
| 每个节点一个独立 JSON 文件 | 文件数激增 (50 节点 = 50 文件)，加载时需逐个读取 |
| 基于 Redis 的中心化状态存储 | Mycoder 是本地 CLI 工具，不应依赖外部服务 |
| Context Window Extension (求和/压缩) | Anthropic 的 prompt caching 和 summarization 已足够，不需要二次压缩 |
| 全量 diff 算法 (类似 git) | 树结构简单，delta 方案 (B4) 已足够，不需要通用 diff |

---

## 验证场景

| # | 场景 | 期望 |
|---|------|------|
| 1 | Worker 输出 2000 词 → reportResult() | 树中 result 字段 <= 300 词 |
| 2 | 根 Agent 每轮 preRoundCheck (无异常) | 返回 null，不注入任何树上下文 |
| 3 | 20 节点树 → AgentTeam(list) | 返回 <= 20 行，约 400 token |
| 4 | 120KB 树调用 saveTree() | 归档原版，主文件精简到 < 100KB |
| 5 | 8 天前的树文件 → cleanOldTrees() | 文件被删除 |
| 6 | 第 51 个节点 → addChildNode() | 返回 null，拒绝添加 |
| 7 | 节点 assignedAgentId 指向已死 Agent → checkSubtreeStatus() | 自动标记 failed/修复 |
| 8 | 启动时加载损坏的 tree JSON → validateAllTreesOnStartup() | 归档损坏文件，不崩溃 |
| 9 | Agent 完成 → completeMember() → 树节点自动同步 | node.status='completed', node.result 同步 |
| 10 | 连续 10 个 delta → saveTree() 全量合并 | delta 文件被清理，base 文件更新 |

---

## 代码改动总结

| 文件 | 改动量 | 新增函数 |
|------|--------|---------|
| `src/task_tree.ts` | +180 行 | `truncateToWordLimit`, `summarizeSubtree`, `compactTree`, `archiveTree`, `cleanOldTrees`, `writeDelta`, `loadTree`(增强), `validateReferences`, `repairStaleReferences`, `syncNodeFromMember`, `validateAllTreesOnStartup` |
| `src/agent_team.ts` | +15 行 | `MemberState` 加 3 字段, `completeMember`/`failMember`/`killMember` 加树同步 |
| `src/agent_def.ts` | +3 行 | Worker system prompt 加 300 词限制 |
| `src/session_loop.ts` | +20 行 | `preRoundCheck` 改为按需检查 (A4) |
| `src/session.ts` | +5 行 | 启动时调用 `cleanOldTrees()` + `validateAllTreesOnStartup()` |
| `src/tools-v2/AgentTool/AgentTool.ts` | +30 行 | `AgentTeam(list/check/deep)` 分级实现 |
