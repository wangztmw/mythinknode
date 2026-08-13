# session-refactor-phase7

> 创建时间：2026-08-06 15:55
> 状态：规划中

## 要做什么

把 WorkTree 从"可选工具"提升为会话循环的必经第一处理阶段。每次对话启动时，由独立的 WorkTree Agent 先分析用户意图、生成任务树，再交给 Agent 集群执行。

## 为什么做

当前 TreeCmd 只是 14 个工具之一——LLM 可能用也可能不用。WorkTree 的价值没有被充分利用。而且后续要做树状记忆和上下文分发，必须先让 WorkTree 成为每次对话的标准入口。

## 预期结果

- "你好" → 单节点树 → 直接回复，不走集群派发
- "调查六个领域" → 6 节点树 → 并行派 6 Worker → 汇总
- 所有任务都走 WorkTree → 集群 → 回复的路径，区别只在树的复杂度
- session_loop 改动约 30 行，新增约 160 行

## 相关计划

- [递归分解协议](../20260806-1341-plan-recursive-decompose/README.md)
- [活着的工作树](../20260806-1414-plan-tree-living/README.md)
