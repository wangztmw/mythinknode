# MessageProcessor — 全量存盘，优化入脑

> 创建时间：2026-08-08 22:21
> 状态：规划中

## 要做什么

在 Query 循环和 Session 存储之间插入 MessageProcessor。每轮对话结束后，原文存盘，增量优化后只把精简版传给下一轮 LLM。

## 为什么做

- 工具噪音（WebSearch 的 3000 字 HTML）永久污染上下文
- CC 的 autocompact 是被动的——爆了才救
- 主动每轮蒸馏，上下文永远精瘦

## 预期结果

- `session/message-processor.ts` 就位
- `session/raw-storage.ts` 磁盘读写就位
- `session_loop.ts` 接入 processor
- 新增标记 `[S{n}]` 让 LLM 知道原文在哪

## 相关计划

- 20260808-1907-去冗余与解耦分析
- 20260808-1903-重构双重循环
