# 任务树精简

> 创建时间：2026-08-07
> 状态：规划中

## 要做什么

砍掉任务树的"计划层"（task_tree/ 11 文件 + work_tree/thinker.ts + TreeCmdTool + 树感知代码），净删 ~4,570 行。保留"隔离层"（Agent + AgentTeam 上下文隔离）。

## 为什么做

15 次测试 + 5 框架对比 + 学术调研结论：树有价值但灵魂不在"计划"在"上下文隔离"。

- 树节点利用率接近零。主 Agent 80% 的活自己干。树建了就退役。
- 主 Agent 同时有编排工具和执行工具 → "既当裁判又当运动员" → 等不及就自己上
- 学术共识：TDP token 减少 82%，生产环境任务树失败率 41-87%（主因是上下文纠缠）
- Claude Code Coordinator：没有文件工具，只能编排——这是正确的设计

## 预期结果

- 工具 14 → 13（砍 TreeCmdTool）
- 净删 ~4,570 行代码
- 保留 Agent(background=true) + AgentTeam 生命周期管理
- 子 Agent 启动只传 task + domain + concepts（上下文隔离）
- 主 Agent prompt 约束"按内容领域派 Agent，不自己执行"
- 版本号 v0.6.0 → v0.7.0

## 相关计划

- [Phase 7 实施](../20260806-1555-session-refactor-phase7/README.md)
- [任务树价值评估调研](../../Plan/调研/任务树价值评估/README.md)
