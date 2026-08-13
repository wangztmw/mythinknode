# 工具系统 & Tool Calling 2.0

> **日期**：2026-08-07
> **调研方式**：三路 Agent 并行 —— CC 工具构建链路源码分析、JSON Schema 层验证机制、Web 搜索 Function Calling 2.0 最新进展

## 背景

需要搞清楚两个东西：(1) CC 当前的工具系统是怎么用 JSON Schema 自动化控制的，从 Zod 定义到 API 调用全链路；(2) Anthropic 提出的 Tool Calling 2.0 / 程序化工具调用是什么，跟当前的 JSON ping-pong 模式有什么区别。

## 关键结论

**CC 工具系统本质：Zod Schema → JSON Schema → API 定义，全链路自动化。**

- 工具作者写 Zod v4 schema（`z.strictObject({...}).describe(...)`），其余全自动
- `buildTool()` 填默认值 → `zodToJsonSchema()` 转 JSON Schema → `toolToAPISchema()` 组装 API 对象
- 10 步调用链路：定义 → 组装 → 模型返回 → Zod 校验 → PreToolUse hooks → 权限检查 → 执行 → mapToolResult → PostToolUse hooks → 注入消息数组
- 双层缓存：`WeakMap` 存 Zod→JSON Schema 转换结果（按对象 identity），`toolSchemaCache` 存 API 序列化结果（防 prompt cache busting）

**Tool Calling 2.0：从 "模型是 JSON 胶水" 变成 "模型是程序员"。**

- 模型不再逐次输出 JSON 调工具，而是**写一段 Python/TypeScript 脚本**，在沙箱里循环调用多个工具
- 中间数据不回流上下文，只有最终 stdout 到达模型——token 消耗降 30-50%
- 懒加载（Tool Search）：全量 130K ↓ 5K token，工具选择准确率 79.5% → 88.1%
- `input_examples`：在工具定义里嵌 1-3 个规范示例，参数生成准确率 72% → 90%
- Claude Code 已经是 Tool Calling 2.0 最激进的消费者：Dynamic Workflows（JS 编排子 Agent）、Tool Search、WebFetch 过滤全上了

**原理模型：1.0 = JSON 乒乓（模型是胶水），2.0 = 程序化编排（模型是程序员）。**

## 文件

- [cc-tool-system.md](./cc-tool-system.md) — CC 工具系统完整架构：Zod→JSON Schema 管线、10 步生命周期、双层缓存、并发模型
- [tool-calling-2.0.md](./tool-calling-2.0.md) — Tool Calling 2.0 详解：程序化调用、懒加载、input_examples、与 CC 的对应关系

## 关联

- [[../claude-code运行机制/]] — 查询循环（工具调用的上游消费者）
- [[../agent集群/]] — Agent 工具（工具系统最大的单一消费者）
- [[../agent协同/]] — 通知机制（PostToolUse hooks 的上下文）
- CC 源文件：`Tool.ts`、`tools.ts`、`utils/api.ts:toolToAPISchema()`、`utils/zodToJsonSchema.ts`、`utils/lazySchema.ts`、`utils/toolSchemaCache.ts`
