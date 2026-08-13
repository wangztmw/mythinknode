# 递归分解协议 — 让 WorkTree 动态生长

> **目标**：子 Agent 发现任务可继续分解 → 反馈主 Agent → 主 Agent 决定替换节点为子树
> **改动**：纯 prompt 层，不改代码。所有机制已在代码层就绪。

---

## 一、协议定义

### 子 Agent → 主 Agent

在 Worker/Supervisor 的 system prompt 中追加：

```
## 动态分解
如果你发现当前任务实际上可以拆成更小的独立子任务：
- 先继续执行当前能做的部分
- 在最终回复的末尾写 [FEEDBACK: DECOMPOSE: 子任务A | 子任务B | 子任务C]
- 用 | 分隔各子任务，每个子任务用简短动词短语描述
- 例：[FEEDBACK: DECOMPOSE: 实现LRU缓存读 | 实现LRU缓存写 | 实现LRU缓存淘汰 | 添加序列化支持]
```

### 主 Agent 收到后

在 Planner/Supervisor 的 system prompt 中追加：

```
## 动态分解处理
AgentTeam check 的 feedback 中如果包含 DECOMPOSE 建议:
1. 评估：这些子任务是否真的独立、粒度是否合适
2. 如果合理: 
   TreeCmd replace(nodeId, 原义群名, "将任务分解为: 子任务A, 子任务B...")
   → TreeCmd add_child × N（每个子任务一个叶节点）
   → Agent × N（每个子节点派一个 background Agent）
   → 用 AgentTeam 追踪新子树进度
3. 如果不合理: 忽略，继续等待原 Agent 完成任务
```

### replaceSubtree 衔接

在 TreeCmd replace 的 system prompt 描述中追加：

```
replace 会删除旧子树并创建新节点。如果旧子树中有 running 的 Agent，先 AgentTeam kill 终止它们，再执行 replace。
```

## 二、收敛保障

递归分解有自然的终止条件（已在 system prompt 中）：

- `isLeaf` 标准：涉及 1-2 文件 + 1 概念 → 不再分解
- MAX_NODES=50 硬限制：防止过度分解
- 子 Agent 自检：`[DONE]` 表示已充分完成，即使可分解也标记完成
- 主 Agent 评估权：DECOMPOSE 建议不是命令，主 Agent 可以拒绝

## 三、全链路示例

```
1. 根 Agent 建树: "重构 config.ts" → 派 Supervisor

2. Supervisor 分解: "重构缓存逻辑" → 派 Worker (node-cache)

3. Worker (node-cache) 执行中发现问题:
   "这个缓存涉及读缓存、写缓存、淘汰策略、序列化——四个独立子任务"
   → 写完当前能写的部分
   → 返回 [PARTIAL: 已实现读写缓存，淘汰和序列化未完成]
   → [FEEDBACK: DECOMPOSE: 实现LRU读缓存 | 实现LRU写缓存 | 实现淘汰策略 | 添加序列化]

4. 主 Agent AgentTeam check → 看到 feedback:
   "💬 DECOMPOSE: 实现LRU读缓存 | 实现LRU写缓存 | 实现淘汰策略 | 添加序列化"
   
5. 主 Agent 评估 → 合理 → 执行:
   AgentTeam kill node-cache 的 Worker
   TreeCmd replace(node-cache, "重构缓存逻辑", "实现LRU缓存全功能")
   TreeCmd add_child ×4 (读/写/淘汰/序列化)
   Agent ×4 (background=true, parent_node_id 各对应子节点)

6. 新子树独立执行 → 更细粒度的并行 → 更高任务质量
```

## 四、改动清单

| 文件 | 改动 | 行数 |
|------|------|------|
| agent_def.ts `_rolePrompt('worker')` | 加"动态分解"段 | +8 |
| agent_def.ts `_rolePrompt('planner')` | 加"动态分解处理"段 | +6 |
| agent_def.ts `_rolePrompt('supervisor')` | 同上 | +6 |
| TreeCmdTool prompt.ts | replace 描述加级联终止提示 | +2 |
| **合计** | | **~22 行** |

纯 prompt 层改动，零代码变更。
