# 冗余代码清理

> 创建时间：2026-08-07 14:27
> 状态：进行中

## 要做什么

删除多 Agent 架构中的 8 处死代码（未使用的字段、空函数、零引用的导出）。净删 ~37 行。

## 为什么做

经过任务树移除和 P1-P5 优化后，通过全量 grep 检查发现残留：
- `depth`/`outputOffset`/`toolUseId` 字段全代码库零读取
- `appendMemberOutput`/`cleanOldMembers`/`listSessions` 函数零调用
- `AgentResult` 类型 import 了但从未用于类型标注
- `subagent_type` 参数解构为下划线前缀（故意不用）

不影响任何运行逻辑，纯代码卫生。

## 预期结果

- 5 个文件净删 37 行
- `npx tsc --noEmit` 零错误
- MemberState 从 20 字段精简到 14 字段

## 相关计划

- [任务树精简](../20260807-1348-任务树精简/README.md)
- [多Agent架构优化](N/A — 本次的父级话题)
