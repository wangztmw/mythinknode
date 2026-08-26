# Token 计数机制

> **日期**：2026-08-05
> **源码**：`utils/tokens.ts` + `services/tokenEstimation.ts`

## 背景

mythinknode 目前没有 token 计数。了解 CC 如何在不调 tokenizer 的情况下快速估算上下文大小。

## 关键结论

不调 tokenizer。用**两层**：

1. **精确层**：从最后一次 API 响应的 `usage` 对象取真实 token 数（`input + cache_creation + cache_read + output`）
2. **估算层**：对 API 响应之后新增的消息，用 `字符数 ÷ 4` 估算（JSON 文件用 ÷2）

```
tokenCount = 最后一次API的精确值 + 新消息字符数 ÷ 4
```

新会话还没调过 API → 纯估算（误差大但上下文小，无所谓）。长对话调过多次 API → 精确部分占绝对大头（估算误差可忽略）。核心代码不到 30 行。

## 文件

- [token-counting.md](./token-counting.md) — 完整机制拆解 + mythinknode 适用性分析

## 关联

- CC 源文件：`utils/tokens.ts` L46, L226 / `services/tokenEstimation.ts` L203, L327
- [[../claude-code运行机制/]] — 上下文压缩（token 计数的上游消费者）
