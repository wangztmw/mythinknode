# 活着的工作树 — 完整计划

## 架构全景

```
用户
  │
  ▼
主 Agent（根节点 ← 唯一树写入者）
  │
  │  TreeCmd status → 一眼看全貌，一次性汇报
  │
  ├─→ Supervisor（分支节点）
  │     │ 可以为自己下面的子节点 spawn Worker
  │     │ 不能修改树 —— 要改 → 反馈主 Agent
  │     │
  │     ├─→ Worker（叶节点）
  │     │     干完 → 树自动检测兄弟们全齐 → 向上发出 children_all_done
  │     │     发现还能拆 → [FEEDBACK: DECOMPOSE: ...] → 主 Agent 决定
  │     │
  │     └─→ Worker
  │
  └─→ Supervisor
        └─→ Worker
```

## 三个核心规则

### 规则 1：树自己向上汇报

```
叶节点 completed
  → 树检查：parent.children 全 completed/failed？
  → 是 → appendWal('children_all_done', parentId)
  → preRoundCheck 推送给主 Agent: "[TREE] children_all_done: OAuth模块"
  
父节点收到审查完成 → 自己 completed
  → 树检查：祖父节点的 children 全 completed？
  → 是 → 再来一次
  → 递归往上 → 最终根节点 → 树完成
```

**主 Agent 不用逐个查。树自己会喊。**

### 规则 2：主 Agent 是唯一树写入者

```
谁可以改树？
  主 Agent: ✅ TreeCmd create/add_child/replace/delete_node
  Supervisor: ❌ 不能。只能看（status/get_leaves/get_node）
  Worker: ❌ 不能。只能看

子 Agent 想改树怎么办？
  写 [FEEDBACK: DECOMPOSE: 子任务A | 子任务B | 子任务C]
  → 主 Agent AgentTeam check 看到
  → 主 Agent 评估 → TreeCmd replace → add_child × N → Agent × N
```

### 规则 3：主 Agent 一键汇报，不走流水账

```
主 Agent 调 TreeCmd status:
  
  🌳 任务树 — 重构认证系统
  ● 重构认证系统 [running]    ← 根
   ├─ ✓ OAuth 模块 [ready]    ← children_all_done，等审查
   │    ├─ ✓ 改 token 刷新
   │    ├─ ✓ 改过期处理  
   │    └─ ✓ 更新调用点
   ├─ ● 密码模块 [running]
   │    ├─ ✓ 改 hash
   │    └─ ◌ 写测试
   └─ ◌ 会话模块 [pending]

  进度: 6/9 | 信号: OAuth模块子节点全齐
 
主 Agent 对用户汇报:
  "OAuth 模块全部完成，密码模块还剩测试，会话模块还没开始。总体 6/9。"
```

## 对比：现在 vs 目标

| | 现在 | 目标 |
|---|---|---|
| 谁改树 | 谁都可以（无限制） | 只有主 Agent |
| 完成信号 | 不回传 | 自底向上，树自己会喊 |
| Supervisor 能否 spawn | 能，但没有 prompt 引导 | 能，且有明确指引 |
| 主 Agent 看状态 | 逐个 AgentTeam check（流水账） | TreeCmd status 一次看全 |
| 对用户汇报 | 一行一行，依赖 LLM 自觉 | prompt 明确要求"先看全貌再汇报" |
| 子 Agent 建议改树 | 没有通道 | [FEEDBACK: DECOMPOSE] → 主 Agent 评估 |

## 代码改动

### 改动 1：core.ts — 完成信号向上传播

`reportResult` 函数末尾追加：

```typescript
// 检查父节点的所有子节点是否全部处于终态
if (node.parentId) {
  const parent = tree.nodes[node.parentId];
  if (parent && parent.children.every(cid => {
    const c = tree.nodes[cid];
    return c && (c.status === 'completed' || c.status === 'failed' || c.status === 'killed');
  })) {
    // 所有子节点终态 → 标记父节点为 ready_for_review
    // （不直接设 completed——父 Agent 需要审查汇总）
  }
}
```

同时在 AgentTool 的 `syncTreeNode` 中调用此检查。可能需要 `appendWal('children_all_done', {nodeId: parentId})` 持久化。

### 改动 2：agent_def.ts — prompt 三层

**默认规则**（主 Agent）追加：
```
- 你是唯一的树写入者。Supervisor/Worker 只能读树不能改。
  如果子Agent建议改树(通过feedback)，由你来评估和执行。
- 对用户汇报前，先用 TreeCmd status 看全貌，一次性汇报总体进度。
  不要逐个节点流水账。用 完成数/总节点数 + 关键阻塞点 的格式。
```

**Supervisor prompt** 追加：
```
- 你可以为自己管辖的树节点创建子Agent（Agent + parent_node_id）。
  但不能修改树结构——那是主Agent的权限。
  如果发现应该拆分节点，通过[FEEDBACK]向主Agent建议。
```

**Worker prompt** 追加：
```
- 如果发现任务可继续分解，写 [FEEDBACK: DECOMPOSE: 子任务A | 子任务B | ...]
  继续完成当前能做的部分。主Agent会评估你的建议并决定是否拆分。
```

### 改动 3：AgentTool.ts — 信号推送增强

在 preRoundCheck 的树事件中追加 `children_all_done` 检测：

```typescript
// 检查树中有没有刚产生的 children_all_done 信号
// 如果有，返回 "[TREE] children_all_done: {nodeId}" 让主Agent知晓
```

### 改动 4：TreeCmdTool.ts — status 输出增强

`renderTree` 输出中，对 `ready_for_review` 状态的节点加 `[ready]` 标记。底部追加汇总行：`进度: N/M | 信号: ...`

---

## 审查结论（4 Agent 并行审查后修正）

### 原计划严重低估

| 维度 | 原估计 | 审查后 |
|------|--------|--------|
| 文件数 | 4 | **9**（+ types/wal/resume/cascade/session_loop） |
| 行数 | ~45 | **~85** |
| children_all_done 实现状态 | "加 12 行" | **完全未实现——10 个缺口** |
| 单写者模型 | 纯 prompt 引导 | **需要代码层拦截** |
| 锁安全 | 未考虑 | **两个 TreeWriteLock 实例不互斥** |

### 关键风险一览

| # | 风险 | 严重度 | 修复 |
|---|------|--------|------|
| 1 | children_all_done 传播链零代码 | 🔴致命 | core.ts 新增 `checkChildrenAllDone` |
| 2 | 单写者模型零代码拦截 | 🔴致命 | TreeCmdTool + AgentTool 加角色检查 |
| 3 | "唯一树写入者"放在默认 prompt 段 → 所有 Agent 看到 | 🔴致命 | 移到 Planner role prompt |
| 4 | 主 Agent 无 preRoundCheck → 树信号无法送达 | 🔴致命 | cli.ts 加 preRoundCheck |
| 5 | WalEntry.event 无 children_all_done | 🟡严重 | types.ts 扩展 |
| 6 | 两个 TreeWriteLock 实例不互斥 | 🟡严重 | 统一为一个实例 |
| 7 | resume 后不重算 children_all_done | 🟡严重 | resume.ts 追加 |
| 8 | cascadeKill 后不触发 children_all_done | 🟡严重 | cascade.ts 追加 |
| 9 | Supervisor prompt "创建子Agent vs 不能改树" 歧义 | 🟡严重 | 明确列出禁止操作的 action 名 |
| 10 | identityLine 缺 DECOMPOSE | 🟢建议 | 同步更新 |

---

## 修正后的改动汇总

| 文件 | 改动 | 行数 |
|------|------|------|
| `types.ts` | WalEntry.event 加 `'children_all_done'` | +1 |
| `core.ts` | 新增 `checkChildrenAllDone()` + `reportResult` 末尾调用 | +25 |
| `wal.ts` | applyEntry 加 children_all_done case | +3 |
| `agent_def.ts` | 三层 prompt（树写入者移到 Planner 段；Supervisor 明确禁止操作名；Worker 加 DECOMPOSE 优先级） | +25 |
| `AgentTool.ts` | syncTreeNode 后调 checkChildrenAllDone；identityLine 加 DECOMPOSE；统一 TreeWriteLock | +10 |
| `TreeCmdTool.ts` | renderTree 加 [ready] + 进度汇总；写操作加角色拦截 | +8 |
| `cli.ts` | 主 Agent 加 preRoundCheck（检查树信号） | +8 |
| `resume.ts` | 恢复后遍历调用 checkChildrenAllDone | +5 |
| `cascade.ts` | cascadeKill 后对被 kill 节点的父节点调 checkChildrenAllDone | +5 |
| **合计** | **9 文件** | **~90 行** |

---

## 分层权限模型（替代一刀切单写者）

| 深度 | 角色 | TreeCmd 权限 |
|------|------|-------------|
| 0 | Planner/主 | 全部（create/add_child/replace/delete_node/report） |
| 1 | Supervisor | 只读（status/get_leaves/get_node/list）+ **Agent 工具通过 parent_node_id 隐式 add_child** |
| ≥2 | Worker | 只读 |

在 TreeCmdTool.call() 入口增加角色检查：
```typescript
const agentDepth = (_ctx.options as any).agentMeta?.depth ?? 0;
const writeActions = ['create', 'replace', 'delete_node', 'report'];
if (writeActions.includes(params.action) && agentDepth > 0) {
  return { data: `只允许主 Agent 执行 ${params.action}。请通过 [FEEDBACK] 向主 Agent 建议。` };
}
```

## 执行监督计划

```
Phase 0: 类型准备（Agent A 单独）
  types.ts: WalEntry + 'children_all_done'

Phase 1: 核心逻辑（Agent B 单独，依赖 Phase 0）
  core.ts: checkChildrenAllDone()

Phase 2: 集成点（4 Agent 并行，依赖 Phase 1）
  Agent C: AgentTool.ts + TreeCmdTool.ts
  Agent D: agent_def.ts
  Agent E: cli.ts + resume.ts + cascade.ts
  Agent F: wal.ts

Phase 3: 监工验收
  编译 + 8 项功能验证
```

验收标准与 plan-tree-living.md 原定相同，追加：
- `checkChildrenAllDone` 对 6 种树状态组合的单元测试
- TreeWriteLock 单例验证（grep 确认只有一个 `new TreeWriteLock`）
- `buildSystemPrompt()` 不含"你是唯一的树写入者"（应在 Planner 段）
- `buildSystemPrompt('planner')` 含此句
