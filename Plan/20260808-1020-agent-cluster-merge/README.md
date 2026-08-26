# Agent 集群架构合并

> 创建时间：2026-08-08 10:20
> 状态：规划中

## 要做什么

删掉 `agent_team.ts` 和 `AgentTeamTool.ts`，把 Agent spawn + 管理合并为一个 `AgentTool` 工具，状态表内聚到 `AgentEngine` 上。5 个文件 → 3 个文件，730 行 → ~400 行。

## 为什么做

1. `agent_team.ts` 的磁盘持久化完全没用——进程退出就丢，没有恢复逻辑
2. `AgentTeamTool` 的 10 个 action 里 7 个几乎不用（inbox/wait/group_*/list）
3. 同一个 team Map 被四个地方以四种方式引用——冗余且容易出错
4. `context_files` 冲突检测是死代码——LLM 从不传这个参数

## 预期结果

- `Agent({action:'spawn'|'check'|'wait_any'|'direct'|'kill'})` 一个工具搞定全部
- 不再有 `agent_team` 和 `AgentTeam` 的 import
- `npx tsc --noEmit` 零错误，`npm run build` 通过
- 端到端：spawn 3 个 Agent → wait_any → check → 信号模式正常

## 相关计划

- Phase 45-46：CLI EOF + Agent 自保机制
- Phase 47：main.ts 模块化重构
