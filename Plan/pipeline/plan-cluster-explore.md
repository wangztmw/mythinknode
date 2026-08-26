# 明日计划：探索 Agent 集群构造

> **创建时间**：2026-08-03
> **目标日期**：2026-08-04
> **前置**：管道设计讨论 + 工具执行解耦
> **现状**：Mycoder 有主 Agent + 子 Agent，但子 Agent 是无结构的——全部平级，没有分工

---

## 一、当前问题

```
主Agent
├── 子Agent-1（"调研React"）
├── 子Agent-2（"调研Vue"）
├── 子Agent-3（"读代码"）
├── 子Agent-4（"写文档"）
└── 子Agent-5（"查API"）

全部平级，没有分工。主Agent 自己管理所有子Agent，
不清楚谁擅长什么，全靠 prompt 描述。
```

## 二、讨论方向

### 2.1 角色化集群

给子 Agent 固定角色：

```
主Agent
├── Scout（搜索+调研）—— 只给 WebSearch/WebFetch/Read
├── Builder（写代码）—— 只给 Bash/Write/Edit
├── Reviewer（审查）—— 只给 Read/Grep/Glob
└── Reporter（汇总）—— 只给 Read（读其他人输出）+ Write
```

每个角色有不同的**工具权限**（Phase 51）、不同的**迭代上限**、不同的**输出格式要求**。主 Agent 根据任务特点分派给对应角色。

### 2.2 动态角色 vs 固定角色

| 方案 | 描述 | 优劣 |
|------|------|------|
| 固定角色 | 引擎预定义三种角色，AgentTool 加 `role` 参数 | 简单，LLM 不用多想 |
| 动态角色 | LLM 自己决定子 Agent 该用什么工具、什么提示词 | 灵活，但可能分配错误 |

### 2.3 子 Agent 的"感知"范围

当前子 Agent 能看到**所有**其他任务（task.ts 共享 Map）。管道模式下应该给它一个**视口**——只看到自己负责范围内的任务。这需要 `AgentContext` 支持视图裁剪。

### 2.4 与 Claude Code 的对应

Claude Code 有：
- `general-purpose` agent — 全功能
- `explore` agent — 只读搜索
- `plan` agent — 只做计划
- `fork` agent — 后台执行，不污染主上下文
- `in_process_teammate` — 进程内协作，可用 SendMessage 通信

Mycoder 可以从中选 2-3 个最需要的角色开始。

## 三、不做的事

- 不实现多进程/远程 Agent
- 不引入 Agent 间直接通信（SendMessage）
- 不引入 Cron 调度

## 四、讨论目标

今天的讨论确定方向，不写代码。明确：
1. 第一版需要几个角色？
2. 角色之间的通信方式？
3. 工具权限如何分配到角色？
4. 是否需要 `AgentContext` 支持视图裁剪？
