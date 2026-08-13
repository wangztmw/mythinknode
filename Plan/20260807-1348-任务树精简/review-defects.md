# 任务树精简 — 缺陷分析报告

> 分析时间: 2026-08-07
> 当前状态: **执行已部分完成**（git diff stat: 36 files changed, -8752 lines）
> 已有 8 个源文件被物理删除（cascade/context/core/persist/resume/validate.ts + TreeCmdTool.ts/prompt.ts），6 个源文件被修改但未提交

---

## 一、已发现的缺陷

### [高危] D1: TreeCmdTool 物理删除路径错误

**描述**: 计划 Layer 10 写 `rm -rf src/task_tree/`，但 TreeCmdTool 的源文件实际位于 `src/tools-v2/task_tree/TreeCmdTool/`（含 TreeCmdTool.ts + prompt.ts）。Layer 10 的命令不会删除它。已在执行中被手动删除，但计划文本自身有误。

**影响**: 任何人严格按计划执行 Layer 10 后，`src/tools-v2/task_tree/` 目录残留，里面包含已无引用的死代码。

**修复**: Layer 10 补充 `rm -rf src/tools-v2/task_tree/`。

---

### [高危] D2: 文件冲突检测被完全移除，无替代机制

**描述**: AgentTool.ts 中 `context_files` 参数支撑两个安全功能：
1. **Agent 间文件冲突检测**（lines 136-148）：检查多个并发 Agent 是否声明操作同一文件，冲突时返回 BLOCKED
2. **文件锁机制**（lines 151-158）：通过 `acquireFileLock` 从 `file_tracker.ts` 获取排他写锁

计划 Layer 4 删除 `context_files` 参数，Layer 10 物理删除 `file_tracker.ts`。删除后，多个并发 Agent 可以同时写同一个文件，无任何冲突检测。这是从"有保护"到"零保护"的功能退化。

**影响**: 并发 Agent 写同一文件 → 数据竞争 → 静默数据损坏。在 Agent(background=true) 并行派发场景下风险显著。

**修复**: 至少保留内存级 file conflict 检测（不依赖 task_tree，仅基于 MemberState 的声明式文件列表）。在 `agent_team.ts` 的 `addMember` 中保留 `contextFiles` 字段，在 AgentTool.call 中保留冲突检测逻辑。只需删除 tree-specific 的 acquireFileLock/releaseFileLocks，保留纯 agent-team 级别的冲突检测。

---

### [高危] D3: 删除顺序违反依赖链，产生中间断裂状态

**描述**: 计划的 11 层执行顺序设计为严格依赖链。但当前执行状态显示 Layer 10（物理删除）已部分先行执行——6 个 task_tree 源文件已被删除（cascade.ts, context.ts, core.ts, persist.ts, resume.ts, validate.ts），而 Layer 1-9 的引用清理尚未完成。

具体断裂点：

| 文件 | 引用的已删除模块 | 状态 |
|------|-----------------|------|
| `AgentTool.ts:191` | `require('task_tree/cascade.js')` → `isAncestorAlive` | **运行时必抛异常**（即使被 try/catch 包裹，每次 preRoundCheck 都触发） |
| `AgentTool.ts:44,69,121,234,272` | `import('task_tree/core.js')` → `syncNodeFromMember/addChildNode/dispatchNode/checkChildrenAllDone` | 动态 import 失败，被 catch 吞掉 |
| `AgentTool.ts:45,108,122,190,235,273` | `import('task_tree/persist.js')` → `loadTree/saveTree` | 同上 |
| `AgentTool.ts:57,75,236,274` | `import('task_tree/wal.js')` → `appendWal` | 同上 |
| `agent_def.ts:80-81` | `require('task_tree/persist.js')` + `require('task_tree/core.js')` | `getTreeContext()` 调用时抛异常 |
| `session_loop.ts:145` | `await import('task_tree/core.js')` → `renderTree` | Phase 7 内已 try/catch，降级 |
| `work_tree/thinker.ts:52-53,79-80` | `import('task_tree/core.js')` + `import('task_tree/persist.js')` | 整个 thinkWorkTree 不可用 |
| `Mycoder.ts:67,81` | `import('task_tree/validate.js')` + `import('task_tree/resume.js')` | setMemberGetter 和 --resume 树恢复均失败 |

**影响**: 当前代码处于不可编译/不可运行状态。如果这是"编辑进行中"的中间态，应在单个 commit 内完成所有修改后再验证。

**修复**: 严格按计划 11 层顺序逐层执行，每层 `npx tsc --noEmit` 验证通过后再进入下一层。或一次性完成所有修改再验证。

---

### [高危] D4: retry.ts 修改不在计划范围内

**描述**: `src/llm/retry.ts` 被修改（retries 3→10, 新增 ECONNRESET/529/jitter 处理, 总超时 180s→600s）。此文件与任务树系统零依赖，修改内容与"任务树精简"主题无关。

**影响**: 变更范围失控。如果此修改有 bug，回退时需要同时回退树精简的所有改动，耦合了不相关变更。违反"一个 commit 做一件事"的原则。

**修复**: 将 retry.ts 的修改拆分到独立 commit/PR。

---

### [中危] D5: cleanOldSessions 删除后无会话清理机制

**描述**: 计划 Layer 6 删除 `cleanOldSessions` import 和调用。`agent_team.ts` 的 `cleanOldMembers()` 已标注 `@deprecated 清理由 cleanOldSessions 统一处理` 且是空函数。删除后，`~/.mycoder/sessions/` 下的历史会话目录将无限累积。

**影响**: 长期使用后磁盘占用持续增长。无自动清理机制。

**修复**: 在 `session.ts` 或 `Mycoder.ts` 中实现简单的会话清理逻辑（如保留最近 N 个会话，删除 7 天前的旧目录），不依赖 task_tree 模块。

---

### [中危] D6: agent_team.ts 的 SESSIONS_DIR 死引用 + agentDir 内联遗漏

**描述**: 计划 Layer 5 只提到"内联 agentOutputPath"，但 `agent_team.ts` 实际使用了 task_tree/paths.ts 的三个导出：

```typescript
// agent_team.ts line 10
import { agentOutputPath, agentDir, SESSIONS_DIR } from './task_tree/paths.js';
```

- `agentOutputPath(sessionId, id)` — line 47，在 `memberOutputPath` 中使用
- `agentDir(sessionId)` — line 52，在 `saveMemberOutput` 中使用 `mkdirSync`
- `SESSIONS_DIR` — **未被 agent_team.ts 直接使用**（只在已废弃的 cleanOldMembers 注释中提到）

**影响**: 如果仅按计划内联 `agentOutputPath` 而忘记 `agentDir`，编译失败。`SESSIONS_DIR` 需要在删除 import 前确认无其他引用。

**修复**: Layer 5 的描述改为"内联 agentOutputPath + agentDir"，并确认 SESSIONS_DIR 无引用后移除。

---

### [中危] D7: --resume 优雅降级实现正确但 plan 描述不精确

**描述**: 计划说"--resume失去树恢复 → 优雅降级,恢复消息但不恢复树"。检查代码后确认这确实能工作：即使删除所有树代码后，`hasUnfinishedSession()` 和 `loadSession()` 不依赖 task_tree（它们只操作 session.json），`--resume` 仍能恢复历史消息。`resumeSessionOrchestrator` 的 try/catch 已经处理了树模块不存在的情况。

**但是**: 当前执行中 `validate.ts` 已被物理删除（在 git diff 中 -493 lines），而 `Mycoder.ts` 的 `setMemberGetter` bridge（lines 66-69）如果尚未被清理，其 `await import('./task_tree/validate.js')` 会失败。但外层已有 try/catch，所以不会崩溃。

**影响**: 低。try/catch 兜底正确。但 plan 文本应补充说明降级的具体行为：恢复消息 + 不恢复树 + 不崩溃。

**修复**: Plan 补充一句"恢复后主Agent 看到历史消息但无树结构，靠 prompt 指引重新规划"。

---

### [中危] D8: AgentTeamTool.ts deep action 残留树引用

**描述**: `AgentTeamTool.ts` line 104:
```typescript
deepResult += `\n\n(no tree associated with this task)`;
```

计划保留 AgentTeamTool 但未提及需更新此提示。树移除后 `deep` action 的显示永远是无树的，提示文本应改为明确说明树功能已移除。

**影响**: 用户体验——Agent 调用 `AgentTeam(deep, id)` 时看到误导性提示。

**修复**: 将提示改为 `(tree feature removed — use check for agent result details)` 或直接移除 deep action。

---

### [低危] D9: 编译层面 — dist/ 残留清理计划不完整

**描述**: 计划 Layer 10 提到"删 dist 中残留的 task_tree 编译产物"。但 `dist/` 下有两个位置：
- `dist/task_tree/` — 11 个 .js 文件
- `dist/tools-v2/task_tree/` — TreeCmdTool 编译产物
- `dist/work_tree/thinker.js` — thinker 编译产物

如果只清理 `dist/task_tree/`，另外两处残留。

**影响**: 编译产物残留不影响运行（因为 import 路径已被删除），但会造成混淆。

**修复**: Layer 10 改为 `rm -rf dist/task_tree/ dist/tools-v2/task_tree/ dist/work_tree/thinker.js` 或直接 `npx tsc --build --clean && npx tsc` 全量重编。

---

### [低危] D10: 计划文件计数与实际有微小偏差

**描述**: 计划说 "task_tree/ (11 文件, ~4,280 行)"。Git HEAD 实际追踪：
- `src/task_tree/`: 11 文件（cascade, context, core, file_tracker, lock, paths, persist, resume, types, validate, wal）
- `src/tools-v2/task_tree/TreeCmdTool/`: 2 文件（TreeCmdTool.ts, prompt.ts）
- `src/work_tree/thinker.ts`: 1 文件
- 合计: 14 源文件

Git diff stat 显示总删除 -8752 lines，远超计划估计的 ~4,570。差额主要来自 validate.ts (493), context.ts (184), AgentTeamTool.ts 修改 (105) 等。

**影响**: 无功能影响，仅文档精度问题。

---

### [低危] D11: AgentTool.ts 混合使用 require 和 import

**描述**: AgentTool.ts 中有些动态导入用 `require()`（lines 190-191），其他用 `await import()`。这是已有代码风格不一致，但删除时需注意两种导入形式都清理。当前 `require('task_tree/cascade.js')` 在 `cascade.ts` 已删除后会抛异常（未被 try/catch，因为在 preRoundCheck 的 if 分支内已有 try/catch）。

实际上 line 188-202 的 preRoundCheck 回调确实在 try/catch 内，所以不会导致未捕获异常。但每次 preRoundCheck 触发都会执行一次失败的 require，属于热路径上的浪费。

**影响**: 低。try/catch 兜底。

---

## 二、计划设计层面的结构性问题

### S1: ConcurrencyLimiter — 与树系统无依赖，计划正确未涉及

`src/llm/concurrency.ts` 的 `ConcurrencyLimiter` 是纯并发控制，不 import 任何 task_tree 模块。只在 `agent_def.ts` 中被 AgentEngine 使用。计划正确跳过了它。

### S2: fetchWithRetry — 与树系统无依赖，计划正确未涉及

`src/llm/retry.ts` 的 `fetchWithRetry` 是纯 HTTP 工具，不依赖树。但当前执行中此文件被意外修改（见 D4）。

### S3: 循环依赖 — 删除后反而解决了一个循环依赖

task_tree 和 agent_team 之间存在循环依赖桥接（通过 `ITreeAgentBridge` 和 `setMemberGetter`）。删除树系统后，这个循环依赖自然消失。这是正向副作用。

### S4: 动态 import 清理 — 计划覆盖了大部分但有一个遗漏

所有 task_tree 的动态 import 位置：

| 位置 | 导入 | 计划覆盖？ |
|------|------|-----------|
| session_loop.ts:141 | thinkWorkTree | Layer 2 |
| session_loop.ts:145 | renderTree | Layer 2 |
| agent_def.ts:80 | loadTree | Layer 3 |
| agent_def.ts:81 | renderTree | Layer 3 |
| AgentTool.ts:11 | sharedLock | Layer 4 |
| AgentTool.ts:44 | syncNodeFromMember | Layer 4 |
| AgentTool.ts:45 | loadTree, saveTree | Layer 4 |
| AgentTool.ts:51 | flushFileOpsToNode | Layer 4 |
| AgentTool.ts:57 | appendWal | Layer 4 |
| AgentTool.ts:69 | checkChildrenAllDone | Layer 4 |
| AgentTool.ts:70 | loadTree | Layer 4 |
| AgentTool.ts:75 | appendWal | Layer 4 |
| AgentTool.ts:108 | loadTree | Layer 4 |
| AgentTool.ts:121 | addChildNode | Layer 4 |
| AgentTool.ts:122 | loadTree, saveTree | Layer 4 |
| AgentTool.ts:152 | acquireFileLock | Layer 4 |
| AgentTool.ts:190 | loadTree | Layer 4 |
| AgentTool.ts:191 | isAncestorAlive | Layer 4 |
| AgentTool.ts:234 | dispatchNode | Layer 4 |
| AgentTool.ts:235 | loadTree, saveTree | Layer 4 |
| AgentTool.ts:236 | appendWal | Layer 4 |
| AgentTool.ts:253 | releaseFileLocks | Layer 4 |
| AgentTool.ts:260 | releaseFileLocks | Layer 4 |
| AgentTool.ts:272 | dispatchNode | Layer 4 |
| AgentTool.ts:273 | loadTree, saveTree | Layer 4 |
| AgentTool.ts:274 | appendWal | Layer 4 |
| AgentTool.ts:292 | releaseFileLocks | Layer 4 |
| AgentTool.ts:299 | releaseFileLocks | Layer 4 |
| Mycoder.ts:67 | setMemberGetter | Layer 6 |
| Mycoder.ts:81 | resumeSessionOrchestrator | Layer 6 |
| thinker.ts:52-53 | createTree, saveTree | Layer 10 (文件删除) |
| thinker.ts:79-80 | createTree, addChildNode, saveTree | Layer 10 (文件删除) |

**结论**: 所有动态 import 已被计划覆盖。Layer 4 覆盖了 AgentTool.ts 的全部 24 个调用点（最大的清理工作量）。

---

## 三、总结

| 等级 | 数量 | 关键项 |
|------|------|--------|
| 高危 | 4 | D1(路径错误), D2(文件冲突检测消失), D3(中间断裂状态), D4(无关修改混入) |
| 中危 | 4 | D5(无清理), D6(内联遗漏), D7(降级描述不足), D8(UI残留) |
| 低危 | 3 | D9(dist残留), D10(行数偏差), D11(代码风格) |

**核心建议**:

1. **D2 是最大的设计缺陷** — 文件冲突检测不应随树一起删除。建议在 `agent_team.ts` 中保留 `contextFiles` 字段和冲突检测逻辑（纯内存操作，不涉及文件系统/task_tree），只删除依赖 `file_tracker.ts` 的文件锁部分。

2. **D5 需要补充** — 在 `session.ts` 添加简单的会话清理（按时间/数量），替代 `cleanOldSessions`。

3. **当前执行状态需要 reset** — 由于 Layer 10 的部分删除已先于 Layer 1-9 执行，代码处于不可编译状态。建议 `git checkout` 恢复所有 .ts 文件，然后严格按 11 层顺序重新执行。
