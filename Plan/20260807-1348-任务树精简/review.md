# 任务树精简 — 综合审查报告

> 审查时间: 2026-08-07 | 2 Agent 并行: 缺陷分析 + 模块协调性
> 审查结论: **通过（有条件）** — 4 个高危问题需在代码中体现，其余在后续迭代中处理

---

## 高危（已纳入执行计划）

### R1: TreeCmdTool 删除路径 → ✅ 已修正
原计划 `rm -rf src/task_tree/` 遗漏 `src/tools-v2/task_tree/TreeCmdTool/`。
修正: Layer 9 补充路径。

### R2: 文件冲突检测 → ✅ 保留内存级检查
原计划完全删除 context_files + file_tracker。修正:
- 保留 `agent_team.ts` 中 `contextFiles` 字段（声明式文件列表）
- 保留 AgentTool.ts 中冲突检测比较逻辑（纯内存操作）
- 仅删除 file_tracker.ts 的文件锁持久化层（acquireFileLock/releaseFileLocks）

### R3: 执行顺序 → ✅ 已调整
原 Layer 3（删 worktree role）在 Layer 10（删 thinker.ts）之前 → thinker.ts 调用不存在的 role。
修正: Layer 10（物理删除 thinker.ts）移到 Layer 3（删 worktree role）之前。

### R4: AgentTool.ts 遗漏代码块 → ✅ 已拆分 Layer 4a/4b
原计划只提 syncTreeNode，遗漏 execute() 内 6 处树代码。
修正: Layer 4a 删 syncTreeNode + prompt.ts，Layer 4b 逐块删 6 处树代码。

---

## 中危（执行时关注 + 后续迭代）

### R5: 会话清理 → 后续补充
cleanOldSessions 删除后 ~/.mycoder/sessions/ 无限增长。
处理: 在 session.ts 添加简易清理（保留最近 10 个会话），下个版本实现。

### R6: agentDir 内联 → ✅ 已补充
原计划只提 agentOutputPath，遗漏 agentDir(mkdirSync)。
修正: 执行步骤中 agent_team.ts Layer 5 同时内联 agentOutputPath + agentDir。

### R7: --resume 降级 → 确认正确
优雅降级实现已正确: try/catch 守卫，恢复消息但不恢复树。
执行时验证: 删除树代码后 `--resume` 仍能恢复历史消息。

### R8: AgentTeamTool.ts deep 提示 → ✅ 已纳入
deep action 有 "(no tree associated with this task)" 残留。
修正: 执行时改为 "(tree feature removed — use check for agent result details)"。

---

## 低危（记录，不阻塞）

- dist 残留清理需覆盖 `dist/tools-v2/task_tree/` 和 `dist/work_tree/thinker.js`
- retry.ts 修改与树无关，混在同一次提交中（接受，不再拆分）
- 行数统计有偏差（实际删除多于计划估计，正常）
- AgentTool.ts 中 require/import 混用（删除后自然消失）

---

## 执行前置条件

✅ 计划文件完整（README / plan / work-mode / execution / review）
✅ 审查完成（缺陷分析 + 模块协调性）
✅ 执行顺序已修订（12 步，依赖关系已校验）
⏳ 待开始执行

## 审查结论

**可以开始执行。** 4 个高危问题已纳入修订后的执行步骤。中危问题在代码中标注，后续迭代处理。
