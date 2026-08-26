# 重构：task.ts → team.ts

> **创建时间**：2026-08-04
> **目标**：重命名，不改变任何逻辑

---

## 一、为什么改

`task.ts` 实际职能：注册表 + 生命周期 + 输出管理。它是"Agent/后台Bash 的团队花名册"，不是"一件事"。"Task"暗示单个工作项，误导。

## 二、改名映射

| 旧名 | 新名 | 理由 |
|------|------|------|
| `task.ts` | `team.ts` | 团队花名册 |
| `TaskState` | `MemberState` | 团队成员状态 |
| `TaskStatus` | `MemberStatus` | 成员状态枚举 |
| `createTask()` | `addMember()` | 加入团队 |
| `completeTask()` | `completeMember()` | 成员完成工作 |
| `appendTaskOutput()` | `appendMemberOutput()` | 追加输出 |
| `readTaskOutput()` | `readMemberOutput()` | 读输出 |
| `getTask()` | `getMember()` | 查成员 |
| `getTaskRegistry()` | `getTeam()` | 获取团队 Map |
| `cleanOldTasks()` | `cleanOldMembers()` | 清理旧成员文件 |
| `saveTaskOutput()` | `saveMemberOutput()` | 写磁盘 (内部用) |
| `TASK_DIR` | `TEAM_DIR` | 输出目录 `~/.mycoder/team/` |

## 三、受影响的文件

| 文件 | 改动 |
|------|------|
| `src/task.ts` → `src/team.ts` | 文件名 + 所有导出改名 |
| `src/Mycoder.ts` | import 路径 + 函数名 |
| `src/agent.ts` | `TaskState` → `MemberState` (类型) |
| `src/tools-v2/AgentTool/AgentTool.ts` | `createTask` → `addMember` |
| `src/tools-v2/BashTool/BashTool.ts` | `_bgHooks` 签名更新 |
| `src/tools-v2/TaskTool/TaskTool.ts` | `readTaskOutput` → `readMemberOutput` |
| `src/session.ts` | 无引用，无需改 |
| `src/llm/*.ts` | 无引用，无需改 |
| `src/cli/*.ts` | 无引用，无需改 |
| `Plan/Agent/*.md` | 文档中 `task.ts` 引用 → 更新 |

## 四、不改的东西

- `TaskTool` 文件名不变 —— LLM 看到的工具名保持 `Task`，用户习惯
- `taskRegistry` 局部变量名不变 —— team.ts 内部怎么叫都行

## 五、风险

| 风险 | 缓解 |
|------|------|
| 全局改名遗漏某处 | TypeScript 编译零错误 = 全改干净了 |
| `~/.mycoder/tasks/` 目录残留 | 保留旧目录 7 天自动清理，新输出写 `~/.mycoder/team/` |
| 旧 session 文件引用 `task.ts` | session 存的是 JSON 数据，不存源码引用 |

## 六、改动量

| 文件 | 行数变化 |
|------|---------|
| `team.ts` (ex-task.ts) | 0 行净增（纯改名） |
| `Mycoder.ts` | ~3 行 |
| `agent.ts` | ~5 行 |
| `AgentTool.ts` | ~3 行 |
| `BashTool.ts` | ~2 行 |
| `TaskTool.ts` | ~2 行 |

总计：~15 行改动，无新文件，无逻辑变更。
