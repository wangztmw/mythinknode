# Agent 调用架构审查与重构计划

> **创建时间**：2026-08-03
> **审查范围**：agent.ts、AgentTool.ts、TaskTool.ts、task.ts、BashTool.ts、Mycoder.ts（6 文件）
> **核心判断**：骨架正确，七个缺口在并发控制、递归约束、上下文传递、进程生命周期四个维度。

---

## 问题总览

| # | 严重度 | 问题 | 归属 Phase |
|---|--------|------|-----------|
| P0-a | 🔴 | 子 Agent 可无限递归创建子 Agent + 横向隔离缺失 | Phase 51 |
| P0-b | 🔴 | 无 LLM 并发控制，峰值 N+1 触发 429 | Phase 52 |
| P1 | 🟡 | AgentTool 绕过 task.ts 创建逻辑（ID 前缀/重复） | Phase 53 |
| P2 | 🟡 | 子 Agent 上下文极简，不知道主 Agent 在做什么 | Phase 53 |
| P3 | 🟡 | detached 后台 Bash 子进程泄露 | Phase 54 |
| P4 | 🟡 | 完成通知截断(1000字符) + 同时完成堆积 | Phase 53 |
| P5 | 🟢 | 无 wall-clock 超时自动 kill | Phase 54 |
| P6 | 🟢 | pendingInstruction 只在循环顶检查 | 已知限制，不做 |

---

## 实施计划

| Phase | 解决的问题 | 文件变更 | 行数 |
|-------|-----------|---------|------|
| [**Phase 51**](./phase-51-agent-recursion-control.md) | 递归控制 + TaskTool 权限边界 | agent.ts, AgentTool.ts, TaskTool.ts, task.ts | +49/-15 |
| [**Phase 52**](./phase-52-llm-concurrency.md) | ✅ 已实施：LLM 并发信号量 | 新增 concurrency.ts, agent.ts, config.ts | +43 |
| [**Phase 53**](./phase-53-context-notification.md) | 上下文注入 + 通知合并 + createTask 统一 | agent.ts, AgentTool.ts, task.ts, Mycoder.ts | +37/-10 |
| [**Phase 54**](./phase-54-process-cleanup-timeout.md) | 进程退出清理 + 子 Agent 超时兜底 | BashTool.ts, Mycoder.ts, task.ts, agent.ts | +45/-7 |
| [**Phase 56**](./phase-56-task-system-upgrade.md) | ✅ 已实施：Task 系统升级 | task.ts, AgentTool, BashTool, TaskTool | +55 |
| [**Phase 57**](./phase-57-reasoning-budget.md) | 推理预算：动态 max_tokens，简单查询不烧 token | agent.ts, llm types, openai.ts, anthropic.ts | +23 |

### 推荐顺序

```
Phase 51（递归+权限）→ Phase 52（并发）→ Phase 53（上下文+通知）→ Phase 54（清理+超时）
```

先修最致命的两个 P0，再依次推进增强性修补。

---

## 不改的边界

| 事项 | 决定 | 理由 |
|------|------|------|
| 子 Agent 用独立进程 | 不做 | 进内存足够，序列化开销 > 收益 |
| 子 Agent 不同 LLM 模型 | 不做 | 使用场景决定，非架构问题 |
| 跨会话子 Agent 持久化 | 不做 | 远超当前范围 |
| P6 实时指令注入 | 不做 | 中断工具调用有风险，当前够用 |
| 自动摘要替代截断 | 暂不做 | 依赖上下文压缩，后续联动 |
| 子 Agent 之间直接通信 | 不做 | 主 Agent 中转足够 |

---

## 与其他 Plan 联动

- `Plan/tool/` — 安全（递归控制）、权限（TaskTool 边界）、沙箱（超时=软沙箱）
- `Plan/大模型/` — 上下文压缩（结果过长时触发）、稳定连接（P0-b 并发控制）
- Phase 46（自保机制）— 主 Agent 防自杀 + 本计划防子 Agent 乱杀兄弟
- Phase 44（Task 生命周期）— 本次重构的基础设施

---

## 更新日志

| 日期 | 事件 |
|------|------|
| 2026-08-03 | 初始创建：7 问题诊断 + 4 Phase 计划，拆分为独立文件 |
