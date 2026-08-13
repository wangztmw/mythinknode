# tools-v2 文件夹重组计划

## 目标结构

```
tools-v2/
  core/           Tool.ts, index.ts               ← 框架
  file/           FileRead, FileWrite, FileEdit, Grep, Glob
  search/         WebSearch, WebFetch
  exec/           Bash
  agent/          Agent, AgentTeam
  task_tree/      TreeCmd                         ← 用户命名
  external/       MCP, Skill
```

## 需要同步的 import 路径

### 第 1 类：各工具 → Tool.ts

所有工具文件都有一行 `import { ... } from '../Tool.js'`。

Tool.ts 从 `tools-v2/` 移到 `tools-v2/core/`，工具从 `tools-v2/XxxTool/` 移到 `tools-v2/{sub}/XxxTool/`：

| 工具 | 旧 import | 新 import |
|------|----------|----------|
| file/Read,Write,Edit,Grep,Glob | `'../Tool.js'` | `'../../core/Tool.js'` |
| search/WebSearch,WebFetch | 同上 | 同上 |
| exec/Bash | 同上 | 同上 |
| agent/Agent,AgentTeam | 同上 | 同上 |
| task_tree/TreeCmd | 同上 | 同上 |
| external/MCP,Skill | 同上 | 同上 |

### 第 2 类：各工具 → 引擎层 (task_tree/)

AgentTool, TreeCmdTool, AgentTeamTool 内部有 `await import('../../task_tree/xxx.js')` 引用引擎模块。

这些工具从 `tools-v2/XxxTool/` 移到 `tools-v2/{sub}/XxxTool/` 后，多了一层目录：

| 工具 | 旧前缀 | 新前缀 |
|------|--------|--------|
| agent/AgentTool | `'../../task_tree/'` | `'../../../task_tree/'` |
| agent/AgentTeamTool | 同上 | 同上 |
| task_tree/TreeCmdTool | 同上 | 同上 |

### 第 3 类：index.ts → 各工具

index.ts 从 `tools-v2/` 移到 `tools-v2/core/`，各工具目录名变了：

| 工具 | 旧 import | 新 import |
|------|----------|----------|
| FileReadTool | `'./FileReadTool/...'` | `'../file/FileReadTool/...'` |
| TreeCmdTool | `'./TreeCmdTool/...'` | `'../task_tree/TreeCmdTool/...'` |
| AgentTool | `'./AgentTool/...'` | `'../agent/AgentTool/...'` |
| ... | 类推 | 类推 |

## 执行

分两步：移动文件 + 修 import。修 import 用 Agent 并行——每类路径一批，互不冲突。

验收：`tsc --noEmit` 零错误 + `grep -r "from '../Tool" src/tools-v2` 无匹配（确认没有遗留旧路径）。
