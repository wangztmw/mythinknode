# 管道化 Agent 架构

> **创建时间**：2026-08-03
> **来源**：对 Claude Code vs mythinknode 工具编排方式的深入讨论
> **目标**：将 Agent 的 Think（LLM）、Act（工具）、Orchestrate（子Agent）解耦为三个平等的管道环节

---

## 目录

| 文件 | 内容 |
|------|------|
| [管道设计讨论](./pipeline-design.md) | 管道模式的架构、优劣、与 Claude Code 的区别 |
| [全量对话记录](./conversation-log.md) | 完整讨论过程 |
| [明日计划：解耦 Agent 组织](./plan-decouple-agent.md) | 第一步——抽出 executeToolCalls，验证解耦可行性 |
| [明日计划：探索集群构造](./plan-cluster-explore.md) | 第二步——多 Agent 集群的组织方式 |

### Claude Code 源码调研 → 已搬至 [`../调研/`](../调研/)

| 专题 | 位置 | 内容 |
|------|------|------|
| Agent 集群机制 | `../调研/agent集群/` | 五种创建模式 + 差距矩阵 + 四迭代计划 |
| Agent 协同约束 | `../调研/agent协同/` | 6 层约束体系：铁律/简报/通知/角色/并发/反模式 |
| 完整运行链路 | `../调研/claude-code运行机制/` | 入口→QueryEngine→query→服务→工具→权限（7 篇） |
| Token 计数 | `../调研/token计数/` | API 精确值 + 字符数 ÷4 估算的两层方案 |

---

## 核心结论

当前 mythinknode 的内联模式（run() 里直接调工具、管子 Agent）适合个人开发，但限制了"让大模型良好组织活动"的能力。管道模式把 LLM 调用、工具执行、子 Agent 编排变成三个平等的黑盒环节，引擎只调度不包办。

**2026-08-05 完整调研后补充**：Claude Code 的架构不是管道——是单层流式反应循环。但它有五种子 Agent 创建模式（Regular/Fork/InProcess/Process/Remote）、六种内置 Agent 类型、多级工具权限过滤。mythinknode 只实现了其中最基础的一种。

**实施路线**（四迭代）：
1. 抽取 `executeToolCalls()` 消除重复 —— 最小可验证步
2. 引入角色系统（Scout/Builder/Reviewer/General）—— 工具权限差异化
3. Agent 间通信 + 集群组织 —— 双向消息 + 协作
4. 管道化正式解耦（Think/Act/Orchestrate Stage）
