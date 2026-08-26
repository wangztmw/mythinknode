# Claude Code 运行机制

> **日期**：2026-08-04 ~ 08-05
> **调研方式**：5 路 Agent 并行读取入口/查询循环/服务/工具/权限 + 前期 4 篇分析

## 背景

要重构 mythinknode，需要理解 CC 从 `claude` 命令到 LLM 返回结果的**完整链路**。

## 关键结论

- CC 的核心是 `queryLoop()` 里的一个 `while(true)` 循环，不是管道
- 22,000 行核心代码中 ~60% 是容错+安全+多用户+SDK 桥接，真正驱动 Agent 的逻辑只有 ~500 行
- 流式工具执行（StreamingToolExecutor）是性能关键——LLM 还在输出时，工具就已经开始跑了
- 不可变状态模式（7 个 continue 站点）不是为了模块化，是为容错恢复
- 权限系统最复杂：7 种模式 × 12 步检查 × 4 路异步竞速

## 文件

| 文件 | 内容 |
|------|------|
| [findings.md](./findings.md) | 执行机制全景概述 + 五层精妙机制 + 与 mythinknode 对比 |
| [runtime-trace.md](./runtime-trace.md) | **★ 全链路逐层拆解**：入口→QueryEngine→query→服务→工具→权限 |
| [queryengine-analysis.md](./queryengine-analysis.md) | QueryEngine 外层：双消息数组 + 会话生命周期 + SDK 桥接 |
| [query-analysis.md](./query-analysis.md) | query.ts 内层：核心循环 + 7 个 continue 站点 + 流式处理 |
| [helpers-analysis.md](./helpers-analysis.md) | 辅助基础设施：权限/上下文/派生/Fork 子 Agent |
| [real-session.md](./real-session.md) | 真实会话记录（224 条消息） |
| [task-tree-solution-context.md](./task-tree-solution-context.md) | 任务树系统：上下文膨胀/存储开销/引用完整性方案 |

## 关联

- CC 源码：`study/claude-code/claude-code-main/src/`
- [[../agent集群/]] — Agent 创建（运行机制的延伸）
- [[../token计数/]] — Token 估算（上下文管理的基础）
