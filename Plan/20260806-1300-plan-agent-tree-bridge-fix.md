# 修复计划：Agent ↔ 任务树桥接断裂 + TreeWriteLock 并发 Bug

> **发现日期**：2026-08-06
> **现象**：LLM 用 TreeCmd 建树→派 Agent→Agent 跑完了但树里节点全 pending→主 Agent 只好自己干了一遍

---

## 一、两个缺陷

### 缺陷 1：TreeWriteLock 并发 batch 异常

**现象**（控制台输出）：
```
[TreeWriteLock] 可重入 acquire：TreeCmdTool 已持有锁，跳过本次 acquire。  (×5次)
[TreeWriteLock] 非持有者尝试释放锁：调用者=TreeCmdTool，当前持有者=无。  (×5次)
```

**根因**：6 个 `add_child` 在同一轮 tool_use 中并发调用，每个都走 `treeLock.batch('TreeCmdTool', async () => {...})`。第一个拿到锁，后面 5 个在 `acquire()` 里检测到 `this.holder === 'TreeCmdTool'` → 触发可重入警告 → 跳过队列直接执行 → 它们没真正持有锁 → 写树时无保护 → 第一个完成后 release → 清空 holder → 后面 5 个再 release → "非持有者"。

**位置**：`src/task_tree/lock.ts` — `acquire()` 方法的可重入检查逻辑有缺陷。它把"同一调用者 ID"当成了"同一调用上下文"，导致并发 batch 用相同 ID 时会绕过队列。

### 缺陷 2：Agent 创建时未关联树节点

**现象**：Agent 派了 6 个 → AgentTeam wait 确认全部完成 → 但 AgentTeam check 显示树节点仍是 pending → 主 Agent 放弃等树、自己上阵干活。

**链路追踪**：
```
TreeCmd add_child → 返回 nodeId (如 "msg-0-abc")
    ↓
LLM 调 Agent(description="AI调查", prompt="...", background=true)
    ↓ 没传 parent_node_id ← 问题在这里
AgentTool.call() 中:
  parent_node_id = undefined
  → 跳过树节点关联代码块
  → task.treeNodeId = undefined
    ↓
Agent 完成后:
  syncTreeNode(task, 'completed', result.text)
  → if (!task.treeNodeId) return; ← 静默跳过
  → 树节点永远停留在 pending
```

**根因 1（工具描述）**：Agent 工具的 `inputSchema` 里 `parent_node_id` 的描述不够明显，LLM 不知道 TreeCmd add_child 返回的 nodeId 应该作为 Agent 工具的参数传入。

**根因 2（上下文缺失）**：TreeCmd add_child 返回的是 `"Child node added: {id} — "{meaning}" ({role}, depth {depth})"`。LLM 看到了 nodeId 但没被提示"下一步调 Agent 时把此 ID 作为 parent_node_id 传入"。

**根因 3（fallback 缺失）**：即使 LLM 忘了传 parent_node_id，AgentTool 也应该尝试自动匹配——如果当前有活跃树且 Agent 未被关联到任何节点，应该自动在根节点下创建关联。

---

## 二、修复方案

### 修复 1：TreeWriteLock 可重入逻辑

**文件**：`src/task_tree/lock.ts`

问题在 `acquire()` 的可重入检查：

```typescript
// 当前（有bug）: 同 ID 直接跳过队列
if (this.locked && this.holder === id) {
  console.warn(`[TreeWriteLock] 可重入 acquire：${id} 已持有锁，跳过本次 acquire。`);
  return;
}
```

改为：**可重入检查只适用于同一调用栈（同步场景），并发场景必须排队**。

方案：去掉可重入优化，都走排队。或者改为 Promise-based 去重——如果同一个 id 已经在队列中排队了，不重复添加。

```typescript
async acquire(id: string, abortController?: AbortController): Promise<void> {
  // 无竞争：直接获取
  if (!this.locked) {
    this.locked = true;
    this.holder = id;
    if (abortController) this.holderAbortController = abortController;
    return;
  }
  
  // ★ 修复：去掉可重入跳过逻辑。所有并发请求都排队。
  // 即使是同一个 id 的重复调用也应该等待前一个释放。
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = this.queue.findIndex(e => e.resolve === resolve);
      if (idx >= 0) {
        this.queue.splice(idx, 1);
        reject(new Error(`TreeWriteLock acquire timeout (${this.TIMEOUT_MS / 1000}s)`));
      }
    }, this.TIMEOUT_MS);

    this.queue.push({ id, resolve, reject, timer, abortController });
  });
}
```

不破不立——直接删掉可重入检查。`batch()` 方法本身就是 acquire→execute→release 的原子操作，不需要可重入。

### 修复 2：Agent ↔ 树节点桥接

**2a. 修改 Agent 工具描述（prompt.ts）**

在 `src/tools-v2/AgentTool/prompt.ts` 中明确告知 LLM 关联方法：

```
When dispatching an agent from a task tree node created by TreeCmd(add_child), 
pass the returned nodeId as `parent_node_id` to link the agent to the tree node.
This allows the tree to track agent progress automatically.
```

**2b. 修改 TreeCmd add_child 返回消息**

在 `src/tools-v2/TreeCmdTool/TreeCmdTool.ts` 的 add_child 返回中追加提示：

```
`Child node added: ${child.id} — "${params.meaning}" (${params.role || 'worker'}, depth ${child.depth})\n💡 Next: Agent(description="...", prompt="...", parent_node_id="${child.id}", background=true)`
```

这样 LLM 看到返回就知道下一步怎么做。

**2c. AgentTool 自动 fallback（兜底）**

如果 `parent_node_id` 未传但 engine 有 activeTreeId，自动在根节点下挂一个新叶节点：

```typescript
// AgentTool.call() 中，parent_node_id 缺失时的 fallback:
if (!parent_node_id && _engine.activeTreeId) {
  // 自动创建关联节点（作为根节点的子节点）
  parent_node_id = tree.rootId; // 挂到根节点下
}
```

**2d. Agent 工具 inputSchema 描述强化**

把 `parent_node_id` 的描述从：
```
'Parent tree node ID. Set when dispatching from a task tree node.'
```
改为：
```
'IMPORTANT: If you created a tree node with TreeCmd(add_child), pass the returned node ID here to link this agent to the tree. This lets the tree automatically track agent completion status.'
```

---

## 三、执行监督计划

### Agent 布局

```
监工 Agent
  ├─ Worker A: lock.ts — 去掉可重入检查，修复并发 batch
  ├─ Worker B: AgentTool prompt.ts + inputSchema — 强化 parent_node_id 描述
  └─ Worker C: TreeCmdTool — add_child 返回消息追加下一步提示
```

### 验收标准

| # | 验证项 | 方法 |
|---|--------|------|
| 1 | `npx tsc --noEmit` 零错误 | 编译 |
| 2 | 6 个并发 `batch()` 不触发可重入警告 | 忽略警告 stderr，确认锁排队正常 |
| 3 | Agent 创建后 `task.treeNodeId` 不为 undefined | 调 Agent(parent_node_id="xxx") → 检查 task |
| 4 | Agent 完成后树节点自动更新为 completed | 端到端：建树→派Agent→等完成→check 树 |
| 5 | add_child 返回包含下一步提示 | 检查返回字符串含 "💡 Next:" |

### 代码量

| 文件 | 改动 | 行数 |
|------|------|------|
| `lock.ts` | 删可重入检查 | -10 |
| `AgentTool/prompt.ts` | 强化 parent_node_id 描述 | +3 |
| `AgentTool/AgentTool.ts` | inputSchema 描述强化 | +2 |
| `TreeCmdTool/TreeCmdTool.ts` | add_child 返回追加提示 | +2 |
| **合计** | | **~17 行** |
