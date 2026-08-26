# 任务树精简 — 完整设计方案

> 基于: 15 次测试观察 + 5 个框架对比 + 学术最佳实践
> 结论: 树有价值但灵魂在上下文隔离。砍掉"计划层"，保留"隔离层"。

---

## 一、目标

- 砍 `task_tree/` 剩余 5 源文件 (~1,124 行) + dist 残留（6 文件源码已提前删除）
- 砍 `work_tree/thinker.ts` (104 行)
- 砍 TreeCmdTool 断裂 import + dist 残留（源文件已缺失）
- 砍 agent_def/AgentTool/session_loop/Mycoder 中的树感知代码 (~350 行，含 6 处未计入原计划的 AgentTool 代码块)
- **净删 ~1,600+ 行源码 + dist 残留清理**, 工具 14→13

## 二、保留

- `Agent(background=true)` + `AgentTeam(list/check/wait/kill/direct/inbox)` — 子Agent生命周期管理
- 上下文隔离: 子Agent启动时只传 task + domain + concepts,不传全量 messages
- `onAgentComplete` 回调替代 children_all_done
- AgentTeam(wait) 替代 TreeCmd(status)

## 三、需要内联的内容

| 内容 | 原位置 | 迁到 |
|------|--------|------|
| LoopResult 类型 | task_tree/types.ts | session_loop.ts |
| sessionPath/sessionDir/SESSIONS_DIR | task_tree/paths.ts | session.ts |
| agentDir/agentOutputPath | task_tree/paths.ts | agent_team.ts |

## 四、执行顺序（审查修订版，12 步）

1. cli.ts: 删 isMainAgent → Phase 7 不触发
2. session_loop.ts: 删 Phase 7 块 + isMainAgent/agentMeta/fileTracker + 内联 LoopResult
3. AgentTool.ts 4a: 删 syncTreeNode 函数 + prompt.ts 删 parent_node_id 指引
4. AgentTool.ts 4b: 删 execute() 内 6 处树代码（addChildNode/contextFiles/cascade/dispatchNode/releaseFileLocks）
5. agent_team.ts: 删 treeNodeId/treeRole/contextFiles + 内联 agentOutputPath
6. Mycoder.ts: 删 cleanOldSessions/setMemberGetter/resume + 修正 saveSession(treeId)
7. session.ts: 删 treeId + 内联 sessionPath/SESSIONS_DIR
8. tools-v2/core/index.ts: 删 TreeCmdTool import + 注册
9. 物理删除: rm src/task_tree/ + rm src/work_tree/thinker.ts
10. agent_def.ts: 删 activeTreeId/*/getTreeContext/worktree role（thinker.ts 已删，安全）
11. agent_def.ts: 重写 prompt — 去掉 TreeCmd 指引，用"按内容领域并行派 Agent"替代
12. dist 清理 + 编译 + 测试

## 五、风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| 主Agent失去树指引后协调变差 | 中 | prompt改"按内容领域派Agent" |
| --resume失去树恢复 | 中 | 优雅降级,恢复消息但不恢复树 |
| 编译断(动态import多) | 中 | 按层清理,每层tsc验证 |
| 回退 | 低 | git checkout <5分钟 |

## 六、新架构速览

```
主Agent (prompt约束: 只编排不执行)
  │
  ├─ Agent(domain="AI调查", concepts=["大模型","算力"], background=true)
  ├─ Agent(domain="绿电调查", concepts=["光伏","储能"], background=true)
  │
  ├─ AgentTeam(wait) → 全完成
  ├─ AgentTeam(check, id) × N → 读结果
  └─ 汇总 → 交付用户
```
