# Agent 协同约束

> **日期**：2026-08-07
> **调研方式**：三路 Agent 并行读取 CC 源码的协同协议、提示词约束、通知流

## 背景

创建子 Agent 容易，但让主 Agent 和多个子 Agent **配合好** 难。需要了解 CC 用什么约束体系来保证协同质量。

## 关键结论

CC 的 Agent 协同靠的不是复杂 IPC 协议，而是**六层约束写死在提示词里**：

1. **Prompt 规则** — 6 条铁律（永远不要委托理解 / 不要 peek / 不捏造 / 不轮询 / 不重复 / 信任结果）
2. **简报规范** — 子 Agent 看不到对话，所以 prompt 必须自包含
3. **通知机制** — XML 格式异步注入，priority: 'later'，不阻塞用户输入
4. **角色分离** — Coordinator 不写代码，Worker 不看对话
5. **并发纪律** — 读并行、写串行、验证独立
6. **反模式清单** — 明确告知模型"永远不要做 X"

**最重要的规则**："Never delegate understanding"——主 Agent 必须先理解子 Agent 的结果，再给精确指令，不能写 "based on your findings, implement it"。

## 文件

- [agent-coordination.md](./agent-coordination.md) — 6 层约束完整拆解 + 对 mythinknode 的五条实践建议

## 关联

- [[../agent集群/]] — Agent 创建（协同的前置）
- CC 源文件：`tools/AgentTool/prompt.ts`、`coordinator/coordinatorMode.ts`、`tools/AgentTool/forkSubagent.ts`
