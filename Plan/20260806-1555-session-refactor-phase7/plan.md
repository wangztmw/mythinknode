# Phase 7：会话循环重构 — WorkTree 作为独立思考单元

> **日期**：2026-08-06
> **前置**：v0.6.0 Task Tree 初版已完成
> **目标**：把 WorkTree 从"可选工具"提升为"会话循环的必经节点"

---

## 一、当前 vs 目标

### 当前

```
agentLoop 启动
  → LLM 自己决定用不用 TreeCmd
  → 用了 → 建树 → 派 Agent → 收结果
  → 没用 → 自己干活
```

TreeCmd 只是一个工具。LLM 可以选，也可以不选。

### 目标

```
agentLoop 启动
  → WorkTree Agent（独立节点，第一轮必执行）
       │
       ├─ 简单任务（"你好"）→ 单节点树 → 直接回复
       │
       └─ 复杂任务 → 分解为义群树 → 交给 Agent 集群
              │
              ▼
         集群执行（现有 agentLoop 复用）
              │
              ▼
         结果汇聚 → 回复用户
```

WorkTree 不再是一个可选工具——它是每次对话的**第一处理阶段**。

---

## 二、核心设计

### 2.1 WorkTree Agent（思考节点）

一个专用的、轻量的 Agent 实例，只做一件事：**理解用户意图，生成任务树**。

```
输入：用户消息 + 上下文摘要（非完整历史）
输出：TaskDecomposition { purpose, parallelism, groups }
      + 决定：自己回复 / 交给集群
```

特征：
- **不执行工具**（不调 Read/Write/Bash/WebSearch）
- **只分析语义**（这个任务有几个独立义群？可并行吗？）
- **极短轮次**（3-5 轮，不参与执行）
- **状态输出**：产出 TaskTree JSON，存入会话目录

### 2.2 集群执行（复用现有 agentLoop）

WorkTree Agent 产出树后，主循环拿到树，按现有机制派发：

```
主 Agent 读树
  → dispatch 可并行的子节点
  → 每个节点 = 一个子 Agent（agentLoop 递归）
  → 监督进度（AgentTeam list + TreeCmd status）
  → children_all_done → 汇总 → 回复用户
```

这部分和现在的机制完全一样——差别只是**树不是 LLM "可选"创建的，而是 WorkTree Agent 必定创建的**。

### 2.3 简单任务的快速路径

```
用户："你好"
  → WorkTree Agent: { purpose: "问候", groups: [{ meaning: "回复问候", isLeaf: true }] }
  → 树只有 1 个叶节点
  → 主 Agent 或 Worker 直接回复
  → 不经过复杂的集群派发
```

判断标准不是代码硬编码——WorkTree Agent 自己判断 `isLeaf`。

---

## 三、架构变化

### 3.1 session_loop.ts 变化

```typescript
async function agentLoop(engine, params) {
  // ★ Phase 7: 第一轮 — WorkTree 思考节点
  if (params.isMainAgent && !params.skipWorkTree) {
    const tree = await runWorkTreePhase(engine, params.messages);
    if (tree) {
      engine.setActiveTree(tree.sessionId);
      params.tree = tree;
    }
  }
  
  // 后续：基于树执行（现有逻辑）
  for (let i = 0; i < maxRounds; i++) {
    // ... 现有循环不变
  }
}
```

### 3.2 新增模块

```
src/
  work_tree/
    thinker.ts        ← WorkTree Agent 专用循环（不执行工具，只分解意图）
    orchestrator.ts   ← 树→集群的桥接（读树 → dispatch → 等 → 汇总）
```

### 3.3 树即上下文载体

每个树节点携带 `context: { files, concepts }`。未来阶段：
- 分发上下文：给 Worker 只传它负责的节点的 context，不传全量
- 树状记忆：跨会话复用树的义群结构
- 增量更新：用户追问时在已有树上追加/替换节点

---

## 四、和现有机制的复用

| 机制 | 复用/新建 |
|------|----------|
| TreeCmd 工具 | 保留，供集群阶段 LLM 手动调 |
| agentLoop | 复用——集群执行走同一个循环 |
| AgentTool | 复用——派 Worker 不变 |
| AgentTeamTool | 复用——监督不变 |
| children_all_done | 复用——信号传播不变 |
| task_tree/ 引擎 | 复用——树结构不变 |
| WorkTree Agent 循环 | **新建**——轻量，不含工具执行 |
| orchestrator | **新建**——树→集群桥接 |

---

## 五、为树状记忆做准备

这一阶段的核心目的：**让 WorkTree 成为上下文分发的载体**。

当前：所有 Agent 共享完整的 `messages` 数组。

未来：
```
messages（完整）
  │
  ▼
WorkTree Agent 压缩为结构化摘要
  │
  ▼
集群中每个 Worker 只收到:
  - 系统 prompt
  - 自己节点的 context.files + concepts
  - 父节点的 meaning + 全局 purpose
  - 不收到其他分支的上下文
```

这样长对话的上下文不会膨胀——每个 Agent 只看自己需要知道的部分。

---

## 六、实施估算

| 模块 | 文件 | 行数 |
|------|------|------|
| WorkTree Agent 循环 | `src/work_tree/thinker.ts` | ~80 |
| 树→集群桥接 | `src/work_tree/orchestrator.ts` | ~60 |
| session_loop 修改 | `src/session_loop.ts` | +30 |
| 现有模块改动 | 其余 | ~20 |
| **合计** | | **~190 行** |

---

## 七、验证清单

- [ ] "你好" → WorkTree Agent 产出单节点树 → 快速回复（不派 Agent）
- [ ] "调查六个领域今天的情况" → 6 节点树 → 并行派 6 个 Worker → 汇总
- [ ] "重构 config.ts" → 分解为 "读代码/改代码/写测试" → 串行执行
- [ ] 用户追问 → 在已有树上追加节点（增量更新）
- [ ] 已有 session 的 agentLoop 行为不变（子 Agent 不走 WorkTree Phase）
