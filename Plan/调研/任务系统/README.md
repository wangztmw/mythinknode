# 任务系统

> **日期**：2026-08-05 ~ 08-07
> **调研方式**：五路 Agent 并行读取 CC 源码 —— 任务工具实现、状态管理、UI 反馈、Agent/Workflow 集成、文件发现

## 背景

Claude Code 的 TaskCreate/Update/List/Get 工具和后台任务通知机制，让模型能自我规划、分阶段执行、实时汇报进度。需要搞清楚这套系统的完整运作方式：模型怎么创建任务？怎么汇报进度？怎么分阶段？用户怎么看到反馈？

## 关键结论

**两套独立的"任务"系统共存：**

1. **AppState 任务系统**（后台进程跟踪）—— 7 种任务类型 × 5 种状态，`framework.ts` 每秒轮询输出增量，终态后通过 XML `<task-notification>` 注入模型上下文。TaskOutputTool/TaskStopTool 操作这套系统。

2. **Disk Todo 系统**（模型的便利贴）—— TaskCreate/Update/List/Get 四个工具，JSON 文件存 `~/.claude/tasks/`。有 blockedBy/blocks 依赖管理，支持 activeForm 实时 spinner 文本。通过 `notifyTasksUpdated()` 信号驱动 UI 刷新。

**反馈走三层：** Spinner 动画文本（读 activeForm） → TaskListV2 图标列表（绿勾/方块/灰框） → XML 通知注入模型消息流。

**分阶段靠两种机制：** Coordinator 模式的 4 阶段流水线（Research→Synthesis→Implementation→Verification），以及 Disk Todo 的 blockedBy 依赖链。

**核心设计洞察：** 任务状态不嵌入 system prompt——它通过 attachment 管道流进去，模型像读用户消息一样"读到"通知。activeForm 同时服务用户（spinner 显示）和模型（提示词告知用途），是唯一的实时汇报通道。

## 文件

- [task-system-mechanism.md](./task-system-mechanism.md) — 完整机制拆解：双态架构、数据模型、反馈链路、分阶段机制、完整生命周期示例

## 关联

- [[../agent集群/]] — Agent 创建（任务系统的下游消费者）
- [[../agent协同/]] — 通知机制（任务通知的协议基础）
- [[../claude-code运行机制/]] — 查询循环（任务通知注入的上下文）
- CC 源文件：`Task.ts`、`tasks.ts`、`tasks/`、`utils/task/framework.ts`、`utils/tasks.ts`、`tools/TaskCreateTool/`、`tools/TaskUpdateTool/`、`tools/TaskListTool/`、`tools/TaskGetTool/`、`tools/TaskOutputTool/`、`tools/TaskStopTool/`、`coordinator/coordinatorMode.ts`
