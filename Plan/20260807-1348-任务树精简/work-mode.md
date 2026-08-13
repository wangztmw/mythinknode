# 工作方式 — 改前 vs 改后

## 一、当前工作方式

```
用户输入
  │
  ▼
session_loop (主Agent循环)
  │
  ├─ Phase 7: thinkWorkTree() → callLLM(worktree role) → 生成 TaskTree
  │   └─ 注入 [WORKTREE] 到 messages
  │
  ├─ 主Agent 决策:
  │   ├─ TreeCmd(create) → 建树节点
  │   ├─ Agent(background=true, parent_node_id=...) → 派子Agent
  │   ├─ TreeCmd(status) → 查树状态
  │   ├─ TreeCmd(kill) → 杀子树
  │   └─ Bash/Write/WebSearch → 自己干
  │
  ├─ 子Agent 完成后:
  │   └─ AgentTool.syncTreeNode() → loadTree → dispatchNode → saveTree → appendWal
  │
  └─ 主Agent 最终自己交付结果
```

**核心问题**：主Agent既当裁判（编排树）又当运动员（自己执行），80%的活自己干。

## 二、修改后的工作方式

```
用户输入
  │
  ▼
session_loop (主Agent循环)
  │
  ├─ (Phase 7 已删除, 不再生成 TaskTree)
  │
  ├─ 主Agent 决策 (prompt约束: 只编排,不执行):
  │   ├─ Agent(background=true, domain="...", concepts=[...]) → 按内容领域派发
  │   ├─ AgentTeam(wait) → 等待所有Agent完成
  │   ├─ AgentTeam(check, id) → 读子Agent结果
  │   ├─ AgentTeam(direct, id, "新指令") → 给子Agent补充指令
  │   └─ AgentTeam(kill, id) → 杀出问题的Agent
  │
  ├─ 子Agent 启动:
  │   └─ 只接收 task + domain + concepts (上下文隔离)
  │   └─ 不传全量 messages
  │
  ├─ 子Agent 完成:
  │   └─ notify → pendingNotifications → 主Agent 下一轮 preRoundCheck 收到
  │
  └─ 主Agent 汇总子Agent产出 → 合成最终交付
```

**核心变化**：
- ❌ 砍 Phase 7（thinkWorkTree 生成任务树）
- ❌ 砍 TreeCmd 工具（主Agent不能用树命令）
- ❌ 砍 treeNodeId/syncTreeNode（AgentTool不再同步树）
- ✅ 保留 Agent(background) + AgentTeam 生命周期
- ✅ 保留上下文隔离（只传 task+domain+concepts）
- ✅ 主Agent prompt 改"按内容领域派 Agent"

## 三、调用链变化

### 改前

```
session_loop.ts
  ├─ thinkWorkTree(thinker.ts) → callLLM → TaskTree
  ├─ TreeCmdTool.execute() → task_tree/core.ts (createTree/addChild/dispatch...)
  │   └─ TreeWriteLock → WAL → cascade
  ├─ AgentTool.execute()
  │   └─ syncTreeNode() → loadTree → dispatchNode → saveTree → appendWal
  └─ agent_def.ts
      ├─ activeTreeId / activeTreeNodeId
      └─ _rolePrompt('worktree')
```

### 改后

```
session_loop.ts
  ├─ (Phase 7 已删除)
  ├─ AgentTool.execute()  ← 简化, 不调 syncTreeNode
  └─ agent_def.ts  ← 只保留 worker/supervisor role
```

## 四、数据流变化

### 改前
```
TaskTree (task_tree/core.ts)
  ├─ TreeWriteLock → WAL → persist
  ├─ cascade → kill 子树
  └─ syncTreeNode → 同步Agent结果到树节点
```

### 改后
```
Agent results → _notify → pendingNotifications → preRoundCheck 刷新 → 主Agent 上下文
```
