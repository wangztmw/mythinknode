# CLI "Thinking (Xs)" 显示异常

> 类型: 通用问题 · 渲染 · 并发 · 事件循环
> 日期: 2026-08-06
> 影响: 所有使用 callLLM + onProgress 的场景

## 现象

- "Thinking" 后面的数字不持续跳动，停在某个值很久然后突然跳
- "Thinking (0.0s)" 出现后数字不变
- 两个 Thinking 标签挤在同一行
- thinking_end 后出现一行残留字符，和 thought 输出混合

## 涉及模块

`agent_def.ts` (callLLM) → `cli.ts` (renderProgress) → `session_loop.ts` (agentLoop) → `llm/retry.ts` (fetchWithRetry)

## 文件

- [root-cause.md](root-cause.md) — 根因分析（3 个独立原因）
- [fixes.md](fixes.md) — 修复历程和效果评估
- [lessons.md](lessons.md) — 可复用的经验教训
