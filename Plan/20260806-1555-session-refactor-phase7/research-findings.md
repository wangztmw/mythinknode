# 任务树系统价值评估 — 多维调研结论

> 3 Agent 并行调研 + 15 次测试观察 + 5 个业界框架对比 + 学术界最佳实践

---

## 结论：树有价值，但不是当前这种用法

### 现在的用法（错了）

树 = 任务计划。先建好，再执行。步骤之间有依赖。主 Agent 是"项目经理"——他看树、派活、监督。但他也有全套工具——等不及了就自己干。树和实际工作是两条平行线。

### 该有的用法（对的）

树 = 上下文边界地图。每个节点 = 一个上下文隔离区。子 Agent 进去之后**只看到自己的 context**，看不到主 Agent 的 30 轮历史、其他分支的搜索结果。这才是树的真正价值。

**树的灵魂不是"计划"，是"隔离"。**

---

## 证据

### 从测试观察

15 次测试，树的节点利用率接近零。主 Agent 80% 的活是自己干的。树建了就退役。但——子 Agent 确实有干净的上下文窗口（"Complete this task:\n调查AI领域...\nReturn a concise report"）——这才是真正在运作的部分。

### 从学术研究

- TDP 论文：Agent 只接收当前节点 + 前置结果，token 减少 82%
- Anthropic 研究：两层层级显著优于扁平 + 层级化记忆性能保持率高 21%
- STRIDE 框架：大多数任务不需要全自主 agent——先评估适不适合用 agent

### 从业界对比

- Claude Code Coordinator：只编排不执行（没有文件工具）→ 必须通过子 Agent 交付
- LangGraph：StateGraph 的 Send API 做并行 fan-out
- CrewAI：Manager 分解任务 → worker 执行 → manager 验证

### 学术共识

> "不要为单纯细分已有工作而增加层级。从单个 agent 开始，再试 prompt，再试工具，最后才升级到多 agent。"

> "生产环境任务树失败率 41-87%。主要失败模式是上下文纠缠。"

---

## 如果重构：方向

**保留**：`Agent(background=true)` + `AgentTeam(list/check/kill)`
**砍掉**：`TreeCmd` + `TreeNode` + `renderTree` + `checkChildrenAllDone` + `replaceSubtree`
**保留但重定义**：用 `context.files` + `context.concepts` 做上下文边界，不用于"追踪进度"
**核心变化**：子 Agent 的 system prompt 注入 "你只负责这个领域的完整交付。自决定搜什么、怎么写" → 内容领域自主

树的价值在于**限制上下文窗口**，不在于**提供工作计划**。
