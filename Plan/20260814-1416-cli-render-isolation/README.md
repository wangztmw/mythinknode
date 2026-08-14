# CLI 渲染隔离 — 子 Agent 事件不灌主屏

> 创建时间：2026-08-14 14:16
> 状态：规划中

## 要做什么

让子 Agent 的进度事件（thinking/tick/thought/tool_display）不再 push 进主 Agent 共享的 `engine.events` 渲染队列，主屏只渲染主 Agent 自己的进度 + 子 Agent 的一句话状态信号（spawned/done/blocked）。

## 为什么做

多 Agent 并行时终端卡顿、闪烁。根因是子 Agent 和主 Agent 共用同一个 `engine.events` 数组：

- 子 Agent 每轮 push `thinking_start`/`tick`/`end`/`thought`/`tool_display`（query_loop.ts 无条件 push）
- spawn 3 个子 Agent，事件量 ×4，每个子 Agent 还有 100ms 心跳 `thinking_tick` + 工具心跳 `toolTick`
- 这些事件被 `pollEvents` 消费 → 同步 `process.stdout.write` 阻塞事件循环 → LLM/输入延迟 = 卡
- 多个 tick 交替 `\r` 覆写同一行 = 屏闪

不做会怎样：多 Agent 场景一直卡顿闪烁，CLI 交互不可用。

## 预期结果

- 子 Agent 的事件流与主屏渲染解耦，spawn N 个 Agent 时主屏事件量仍等于 1 个 Agent
- 子 Agent 的实时状态仍通过 `member.agentLoop`（lastActivity/lastOutput）可查，不影响 `Agent(check)` 的进度查看
- 主屏只看到：主 Agent 进度 + "Agent done/blocked" 通知信号

## 相关计划

- [20260808-1020-agent-cluster-merge](../20260808-1020-agent-cluster-merge/README.md)（Agent 集群合并，引入了共用 events 的结构）
- [20260806-1555-session-refactor-phase7](../20260806-1555-session-refactor-phase7/README.md)
