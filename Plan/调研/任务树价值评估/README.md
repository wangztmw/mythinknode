# 任务树价值评估

> 背景: 15 次测试后发现任务树节点利用率接近零。主 Agent 80% 的活是自己干的。树建了就退役。
> 目标: 客观评估当前任务树系统是否有价值、缺了什么、该砍还是该重构。
> 方法: 3 Agent 并行调研——自评（15 次测试观察）+ 业界框架对比（LangGraph/AutoGen/CrewAI/Claude Code/TDP）+ 学术最佳实践

## 关键结论

**树有价值，但灵魂不在"计划"在"上下文隔离"。**

- 当前用法（错了）: 树 = 任务计划。建好再执行。主 Agent 是"项目经理"——但他也有全套工具，等不及就自己干
- 该有的用法: 树 = 上下文边界地图。每个节点 = 一个上下文隔离区。子 Agent 进去只看到自己的 context，看不到其他分支
- 学术共识: TDP 做到 token 减少 82%。STRIDE 框架：大多数任务不需要全自主 agent
- 业界对比: 我们的独特优势是 WAL+崩溃恢复、显式并行分析、超时 abort、安全异常检测——但上下文隔离只在中等水平

## 建议方向

保留 Agent(background=true) + AgentTeam。砍掉 TreeCmd + TreeNode + renderTree + replaceSubtree。用 context.files + concepts 做上下文边界，不用于"追踪进度"。子 Agent 启动时不传全量 messages——只传节点的 task + context。
