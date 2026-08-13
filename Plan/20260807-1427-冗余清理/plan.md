# 冗余代码清理 — 完整设计

## 删除清单

| # | 文件 | 删除内容 | 原因 |
|---|------|---------|------|
| 1 | `agent_team.ts` | `depth: number` 字段 + 赋值 | 零读取 |
| 2 | `agent_team.ts` | `outputOffset: number` 字段 + 3处赋值 | 零读取 |
| 3 | `agent_team.ts` | `toolUseId?: string` 字段 | 零读写 |
| 4 | `agent_team.ts` | `appendMemberOutput()` 函数 (8行) | 零调用 |
| 5 | `agent_team.ts` | `cleanOldMembers()` 空函数 | 空函数体 |
| 6 | `Mycoder.ts` | `cleanOldMembers` import + 调用 | 对应#5 |
| 7 | `agent_def.ts` | `AgentResult` interface + session_loop import | 仅import未用于类型 |
| 8 | `AgentTool.ts` | `subagent_type` 参数 | 解构为 `_type` |
| 9 | `session.ts` | `listSessions()` 函数 (11行) | 零导入 |

## 保留

- `oldSessionPath` + 旧格式迁移逻辑（向后兼容）
- 所有运行逻辑（不改一行功能代码）

## 风险

无。所有删除项都经过全量 grep 确认零引用。编译即验证。
