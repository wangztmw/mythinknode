# Agent 集群创建机制

> **日期**：2026-08-05
> **调研范围**：Notion 空间 + 本地项目 + CC 完整源码

## 背景

mythinknode 有主 Agent + 子 Agent，但子 Agent 全部平级、无分工、无通信。需要了解 CC 是怎么支持多种创建模式的。

## 关键结论

- CC 有**五种**子 Agent 创建模式：Regular / Fork / InProcess Teammate / Process Teammate / Remote
- mythinknode 只实现了 Regular（平级、全工具、无通信）
- CC 的 6 种内置 Agent 类型本质是**工具白名单 + 迭代上限 + 输出格式**的组合
- **最大发现**：CC 也没解决"模型主动用 Agent"的问题——只有 Coordinator 模式做到了

## 文件

- [agent-cluster-research.md](./agent-cluster-research.md) — 完整调研报告 + mythinknode 差距矩阵 + 四迭代实施计划

## 关联

- [[../agent协同/]] — 协同约束（调研集群的后续）
- [[../claude-code运行机制/]] — 运行链路（理解 Agent 执行的上下文）
