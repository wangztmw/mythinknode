# 去冗余 + 解耦

> 创建时间：2026-08-08 19:07
> 状态：规划中

## 要做什么

消除三处代码冗余，分析并记录当前耦合点。

## 为什么做

1. `agent_def.ts` 持有死字段 `private tools`
2. `buildSystemPrompt()` 每次调都 `new ConfigStore()`——重复创建
3. `WebSearchTool` 通过全局 `loadConfig()` 读 tavilyApiKey——绕过工具抽象

## 预期结果

- `agent_def.ts` 无未使用字段
- `buildSystemPrompt` 不重复创建对象
- WebSearchTool 不绕过工具层直接读 config
- 耦合分析文档输出到 work-mode.md
