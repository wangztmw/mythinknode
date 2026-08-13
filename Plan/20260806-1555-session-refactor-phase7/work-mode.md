# 修改后的预期工作方式

## 1. 当前工作方式

```
用户发一句 → CLI line 事件 → processLine
  → agentLoop(engine, { messages, maxRounds: 25 })
       │
       for 25 轮:
         callLLM → LLM 回复 end_turn? → 返回文本
                   LLM 回复 tool_use? → executeTools → 下一轮
                        ↑
                   LLM 自己决定要不要用 TreeCmd
```

TreeCmd 只是 14 个工具之一。LLM 可选可不选。没有强制的工作树阶段。

## 2. 修改后的工作方式

```
用户发一句
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│              agentLoop(engine, params)                    │
│                                                          │
│  ┌────────────────────────────────────────────────┐     │
│  │ 阶段 1: WorkTree 思考（注入点：for 循环之前）    │     │
│  │                                                │     │
│  │ if (params.isMainAgent) {                      │     │
│  │   workTree = thinkWorkTree(engine, messages)   │     │
│  │   engine.setActiveTree(workTree.sessionId)     │     │
│  │   messages.push("[WORKTREE]\n" + renderTree)   │     │
│  │ }                                              │     │
│  │                                                │     │
│  │ thinkWorkTree 内部:                             │     │
│  │   - 专用 systemPrompt（"只做语义分解"）         │     │
│  │   - 不调 executeTools（无工具）                │     │
│  │   - 3-5 轮上限                                 │     │
│  │   - 输出 TaskDecomposition → createTree        │     │
│  │                                                │     │
│  │ 产出:                                          │     │
│  │   简单任务 → 单节点树 → 不派 Agent，直接回复    │     │
│  │   复杂任务 → 多节点树 → 进入阶段 2              │     │
│  └──────────────────┬─────────────────────────────┘     │
│                     │                                    │
│  ┌──────────────────▼─────────────────────────────┐     │
│  │ 阶段 2: 集群执行（现有 for 循环，不变）          │     │
│  │                                                │     │
│  │ for (i = 0; i < maxRounds; i++):               │     │
│  │   callLLM → LLM 看到树 → dispatch 并行分支      │     │
│  │   → AgentTool 派 Worker                         │     │
│  │   → AgentTeam 监督                              │     │
│  │   → children_all_done → 汇总 → 回复用户         │     │
│  └────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────┘
```

## 3. 调用链变化

### 改前

```
cli.ts → agentLoop → [25 轮 callLLM/executeTools] → 返回文本
```

### 改后

```
cli.ts → agentLoop
           ├─ thinkWorkTree (3-5 轮，无工具)
           │    └─ callLLM × N → 解析 → createTree → saveTree
           │
           └─ [25 轮 callLLM/executeTools]
                ├─ AgentTool → agentLoop (子 Agent，不走阶段 1)
                ├─ TreeCmdTool → task_tree/*
                └─ AgentTeamTool → agent_team
```

### 关键约束

- 阶段 1 只在 `isMainAgent=true` 时触发
- 子 Agent（`isMainAgent=false`）直接进入阶段 2
- 阶段 1 产出为空（LLM 无法解析意图）→ 降级为直接进入阶段 2（兼容现有行为）

## 4. 数据流变化

### 改前

```
用户消息 → engine.sessionMessages → agentLoop
                                       └─ callLLM 看到完整 messages
```

### 改后

```
用户消息 → engine.sessionMessages
              │
              ├─→ thinkWorkTree（压缩版: 最近 N 轮 + 最新消息）
              │      └─ 产出 TaskTree → 存磁盘
              │
              └─→ agentLoop 阶段 2
                     └─ messages 注入 [WORKTREE] + renderTree 文本
                     └─ 子 Agent 通过 parent_node_id 关联树节点
                     └─ Agent 完成 → syncTreeNode → children_all_done 向上传播
```

### 数据持有

| 数据 | 持有者 | 生命周期 |
|------|--------|---------|
| TaskTree | 磁盘 (`sessions/{id}/tree.json`) | 跨轮次 |
| activeTreeId | engine | 内存，一次会话 |
| treeNodeId | MemberState | 内存，Agent 存活期间 |
| children_all_done 信号 | WAL + notify | 事件驱动 |
