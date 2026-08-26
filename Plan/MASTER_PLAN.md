# my-coder: 主计划

> **当前版本**：v0.6.0
> **最后更新**：2026-08-14

---

## 当前状态

- **代码**：src/ ~55 文件，~6,200 行（含 task_tree/ 10 文件 2,952 行）
- **工具**：14 个（新增 TreeCmdTool）
- **任务树系统**：完整实现——建树/分解/派发/同步/WAL/恢复/收敛/文件锁/级联终止
- **发布**：npm `@wangzt_mw/my-coder@0.5.1` 已发布
- **Plan**：60+ .md 文件，覆盖 Agent/terminal/pipeline/tool/大模型

---

## 进行中

| 项目 | 内容 | 文件 |
|------|------|------|
| — | **备用屏 + 滚动缓冲**：程序接管屏幕渲染，内存缓冲 + 滚轮回看，根治 Terminal 渲染崩溃 | [20260815-1315-alt-screen-buffer/](20260815-1315-alt-screen-buffer/README.md) |
| — | **CLI 输入 + 心跳频率**：渲染 12.5Hz→1Hz（对齐 Claude Code）+ 多行粘贴（bracketed paste） | [20260814-1625-cli-input-heartbeat/](20260814-1625-cli-input-heartbeat/README.md) |
| — | **CLI 渲染隔离**：子 Agent 事件不灌主屏（silent 参数贯穿 agentLoop，多 Agent 卡顿根治） | [20260814-1416-cli-render-isolation/](20260814-1416-cli-render-isolation/README.md) |
| — | **锦上添花**：断连信号修复（9 断开 + 7 部分 = 16 项） | [20260806-1315-plan-jin-shang-tian-hua.md](20260806-1315-plan-jin-shang-tian-hua.md) |

## 待实施

| 项目 | 内容 | 文件 |
|------|------|------|
| — | 工具层安全/权限/沙箱 | Plan/tool/ |
| — | 大模型层上下文压缩 | Plan/大模型/ |

---

## 已完成

### 任务树系统（2026-08-05 ~ 2026-08-06）

| Phase | 内容 | 产出 |
|-------|------|------|
| 设计 | 语义驱动的层次化 Agent 集群 | [plan-task-tree-overview.md](pipeline/plan-task-tree-overview.md) |
| 审查 | 6 Agent 并行审查（交叉冲突/实现风险/性能/遗漏/成本/架构） | [plan-task-tree-review.md](pipeline/plan-task-tree-review.md) |
| 0 | 类型地基（21 类型/接口） | `src/task_tree/types.ts`（220行） |
| 1 | 核心引擎（core/lock/persist/wal/cascade） | 5 文件，1,630 行，29 函数 |
| 2 | LoopResult 单向门（agentLoop 返回结构化类型） | session_loop/cli/AgentTool/agent_team/agent_def |
| 3 | 工具集成（TreeCmdTool + AgentTool/AgentTeamTool 增强） | 14 工具，收敛检查 + 冲突检测 + 身份注入 |
| 4 | 校验与恢复（validate/context/file_tracker/resume） | 4 文件，18 函数 |
| 5 | 提示词分层（Planner/Supervisor/Worker 按角色 prompt） | agent_def.ts |
| 6a | P0 链路连通（8 致命缺口修复） | lockSession/树 ID 统一/treeNodeId 关联/dispatchNode+WAL 调用/subConfig 传参 |
| 6b | P1 功能补全（13 项未实现） | decomposeWithValidation/ITreeAgentBridge/级联终止/WAL compaction/Delta/文件锁/发散检测/安全检测/addChildNode 守卫 |
| 6c | P2 UX 改进（get_node/delete_node/去重/覆盖警告/发散显示） | TreeCmdTool + AgentTeamTool |
| — | **fetch 超时修复**（retry.ts重写 + callLLM try/finally + concurrency setTimeout） | retry/agent_def/concurrency/session_loop |
| — | **默认 prompt 加 TreeCmd 使用指引**（多领域/多文件/多步骤→建树→拆→派→收） | agent_def.ts |
| — | **Agent↔树桥接 + TreeWriteLock 并发修复**（可重入检查删除 + add_child 返回提示 + parent_node_id 强化） | lock/TreeCmdTool/AgentTool |

**任务树系统详细文档**：
- [实施总览](pipeline/plan-task-tree-overview.md)
- [完整设计 v2](pipeline/plan-task-tree-v2.md)
- [六维度审查报告](pipeline/plan-task-tree-review.md)
- [改善计划 + 附录](pipeline/plan-task-tree-fix.md)
- [执行计划](pipeline/plan-task-tree-execution.md)

### 统一 Agent 循环 + 团队重构（2026-08-04 ~ 2026-08-05）

| Phase | 内容 | 日期 |
|-------|------|------|
| — | agentLoop() 统一循环（消除 60 行重复 + 15 行死代码） | 08-05 |
| — | agent_team 共享白板 + 双向反馈（[FEEDBACK]/[BLOCKED] 标记） | 08-05 |
| — | agent.ts 拆分为 agent_def.ts + session_loop.ts | 08-05 |
| — | task.ts → agent_team.ts 重命名 | 08-05 |
| — | 子Agent 工具串行/并行差异发现与保护 | 08-05 |
| — | Claude Code 四层子Agent消息隔离研究 | 08-04 |
| — | Claude Code 五级工具权限体系研究 | 08-04 |
| — | Claude Code Fork Agent 机制研究 | 08-04 |

### 早期基础设施（2026-08-02 ~ 2026-08-04）

| Phase | 内容 | 日期 |
|-------|------|------|
| 52 | LLM 并发信号量 | 08-03 |
| 55 | 事件驱动 stdin + 输入队列 | 08-03 |
| 56 | Task 系统升级（pending/disk/notified） | 08-03 |
| — | 终端崩溃修复（term-wrap） | 08-03 |
| — | 网络可靠性（retry.ts） | 08-03 |
| — | 会话持久化（session.ts） | 08-03 |
| — | Claude Code 执行机制完整研究 | 08-04 |

---

## 历史记录

<details>
<summary>Phase 0-50（展开查看）</summary>

原 MASTER_PLAN 内容：Phase 7-12 深度清理，工具复杂度排序，等等。

</details>

| 工具 | 文件数 | 行数 | import数 | 难度 |
|------|--------|------|----------|------|
| GlobTool | 3 | 267 | 34 | ⭐ |
| WebSearchTool | 3 | 569 | 34 | ⭐ |
| GrepTool | 3 | 795 | 41 | ⭐ |
| FileWriteTool | 3 | 856 | 73 | ⭐⭐ |
| MCPTool | 4 | 1,086 | 39 | ⭐⭐ |
| WebFetchTool | 5 | 1,131 | 52 | ⭐⭐ |
| SkillTool | 4 | 1,477 | 85 | ⭐⭐⭐ |
| FileReadTool | 5 | 1,602 | 89 | ⭐⭐⭐ |
| FileEditTool | 6 | 1,812 | 108 | ⭐⭐⭐ |
| BashTool | 18 | 12,411 | 295 | ⭐⭐⭐⭐⭐ |

---

## 分阶段计划

### Phase 7：修复基础——类型系统 + 核心接口

**目标**：让类型系统和核心接口可编译，消除所有遥测/Anthropic专有宏依赖。

**文件清单**：
- [ ] `src/Tool.ts` (792L) — 删除遥测事件类型导入、Anthropic feature引用
- [ ] `src/Task.ts` (125L) — 删除已删除模块引用
- [ ] `src/commands.ts` (754L) — 删除遥测注入、feature()调用
- [ ] `src/tools.ts` (389L) — 删除feature()条件加载
- [ ] `src/types/` (7文件, 2,071L)
  - [ ] `permissions.ts` — 删除遥测引用
  - [ ] `hooks.ts` — 删除已删除模块引用
  - [ ] `command.ts` — 同上
  - [ ] 其余文件评估是否保留

**预计工作量**：~15文件，~3,500行需要审查

**验证标准**：`npx tsc --noEmit src/Tool.ts src/Task.ts src/tools.ts` 只报缺失模块错误（不报遥测/feature错误）

---

### Phase 8：修复服务层——MCP客户端 + 工具执行管道

**目标**：让MCP和工具执行管道可编译。

**文件清单**：
- [ ] `src/services/mcp/` (23文件, 12,310L)
  - [ ] `client.ts` (3,348L) — 核心：MCP连接/发现/缓存。删除feature()门控
  - [ ] `auth.ts` (2,465L) — 大量OAuth/企业认证代码，大部分可删除
  - [ ] `config.ts` (1,578L) — MCP配置管理
  - [ ] `useManageMCPConnections.ts` (1,141L) — React Hook，删除或重写为纯函数
  - [ ] `xaa.ts` / `xaaIdpLogin.ts` — 企业IdP登录，删除
  - [ ] `claudeai.ts` — Claude.ai专用，删除
  - [ ] `vscodeSdkMcp.ts` — VSCode SDK，删除
  - [ ] `MCPConnectionManager.tsx` — React组件，重写
  - [ ] 其余小文件 — 逐个评估
- [ ] `src/services/tools/` (4文件, 3,113L)
  - [ ] `toolExecution.ts` (1,745L) — 9阶段执行管道，核心保留
  - [ ] `toolHooks.ts` (650L) — 删除已删除模块的hook引用
  - [ ] `StreamingToolExecutor.ts` (530L) — 流式执行器

**预计工作量**：~27文件，~15,000行需要审查

**验证标准**：`npx tsc --noEmit src/services/mcp/client.ts src/services/tools/toolExecution.ts` 只报缺失工具模块错误

---

### Phase 9：逐个修复工具（从简到难）

**原则**：每修完一个工具就跑一次编译验证。不改逻辑，只删死代码和修复import。

#### Phase 9a：最简单工具

- [ ] `GlobTool/` (3文件, 267L)
  - 删除 UI.tsx（Ink组件，已无用）
  - 修复 import 路径
  - 删除 tool 中的遥测调用
- [ ] `WebSearchTool/` (3文件, 569L)
  - 同上
- [ ] `GrepTool/` (3文件, 795L)
  - 同上

#### Phase 9b：中等工具

- [ ] `FileWriteTool/` (3文件, 856L)
- [ ] `MCPTool/` (4文件, 1,086L)
- [ ] `WebFetchTool/` (5文件, 1,131L)

#### Phase 9c：复杂工具

- [ ] `SkillTool/` (4文件, 1,477L)
- [ ] `FileReadTool/` (5文件, 1,602L)
- [ ] `FileEditTool/` (6文件, 1,812L)

#### Phase 9d：BashTool（最大模块）

- [ ] `BashTool/` (18文件, 12,411L, 295 imports)
  - [ ] `BashTool.tsx` — 主逻辑，删除遥测/feature/UI依赖
  - [ ] `bashSecurity.ts` (核心安全校验，保留)
  - [ ] `bashPermissions.ts` (14步权限检查，简化)
  - [ ] `shouldUseSandbox.ts` (保留但简化)
  - [ ] `readOnlyValidation.ts` / `pathValidation.ts` / `sedValidation.ts` (保留)
  - [ ] `bashCommandHelpers.ts` / `commandSemantics.ts` (保留)
  - [ ] `destructiveCommandWarning.ts` (保留)
  - [ ] `UI.tsx` (删除)
  - [ ] `prompt.ts` (保留，去Anthropic专有引用)
  - [ ] 其余辅助文件

**预计工作量**：~55文件，~22,000行需要审查

**验证标准**：每完成一个工具，`npx tsc --noEmit src/tools/<ToolName>/*.ts` 零错误

---

### Phase 10：修复 utils/（按需修复）

**原则**：不逐个修317个文件。先修被工具和服务引用的文件，其余的保持断裂状态作为参考。

**优先级文件**（被多个模块引用）：
- [ ] `utils/config.ts` (1,817L) — 全局配置，需大幅简化
- [ ] `utils/model/model.ts` (618L) + 同目录其余文件 — 模型选择
- [ ] `utils/Shell.ts` (474L) — Shell执行封装
- [ ] `utils/envUtils.ts` (183L) — 环境变量
- [ ] `utils/errors.ts` (238L) — 错误处理
- [ ] `utils/cwd.ts` (32L) — 工作目录
- [ ] `utils/auth.ts` (2,002L) — 认证（大幅简化）
- [ ] `utils/mcp/` (2文件) — MCP辅助
- [ ] `utils/task/` (5文件) — 任务框架

**预计工作量**：~30文件，~6,000行需要修复

---

### Phase 11：修复 QueryEngine 并串联所有模块

**目标**：让 Agent 循环跑起来——QueryEngine 调用真实工具，而非 main.ts 的简化版。

**文件清单**：
- [ ] `src/QueryEngine.ts` (1,295L) — 大规模修复
  - 删除所有遥测/feature/MACRO引用
  - 修复 import 路径指向修复后的模块
  - 简化成本追踪（删除 cost-tracker 依赖）
  - 简化消息处理（删除 state/AppState 依赖）
- [ ] `src/main.ts` — 重构入口，从简化版升级到真实工具系统
  - 用 Tool接口 替代手写工具
  - 用 services/tools/toolExecution 替代手动执行
  - 用 services/mcp 替代硬编码的 fetch

**验证标准**：`npx tsc` 项目级零错误。`node dist/main.js` 使用真实工具系统运行。

---

### Phase 12：最终清理与验证

**目标**：删除所有残留死代码，确保零遥测、零Anthropic控制。

- [ ] 全量扫描：`grep -r "sentry\|posthog\|datadog\|growthbook\|feature(\|bun:bundle\|MACRO\." src/` 返回零结果
- [ ] 全量扫描：`grep -r "from '.*\/bootstrap\|from '.*\/state\/\|from '.*\/memdir" src/` 返回零结果或仅剩utils/未修复文件
- [ ] 删除所有 UI.tsx 文件（或替换为非UI版本）
- [ ] 删除 `src/entrypoints/`（已完全废弃）
- [ ] 删除 `src/cli/print.ts`（5,594行残留）
- [ ] 运行端到端测试：Bash + Read + Write 三个工具通过真实Tool接口调用
- [ ] 更新 CORE_KEPT.md 和 STRIPPED.md
- [ ] 记录到 history/

---

## 每次操作的记录规范

每完成一个Phase内的一个子任务，必须在 `Plan/` 下记录：

```
Plan/
├── phase-7-types.md       ← Phase 7 详细操作记录
├── phase-8-services.md    ← Phase 8 详细操作记录
├── phase-9-tools.md       ← Phase 9 详细操作记录
│   ├── 9a-glob.md         ← 或每个工具单独记录
│   └── ...
├── phase-10-utils.md
├── phase-11-queryengine.md
└── phase-12-final.md
```

每条记录包含：
- 操作的文件名
- 删除了什么（具体到行或函数）
- 修改了什么（具体到import替换）
- 编译状态（通过/失败/具体错误）
- 备注（为什么这么做）

---

## 总工作量估算

| Phase | 文件数 | 行数 | 预计时间 |
|-------|--------|------|---------|
| Phase 7 (类型系统) | ~15 | ~3,500 | 1-2小时 |
| Phase 8 (服务层) | ~27 | ~15,000 | 2-3小时 |
| Phase 9 (工具) | ~55 | ~22,000 | 3-5小时 |
| Phase 10 (utils) | ~30 | ~6,000 | 1-2小时 |
| Phase 11 (串联) | ~5 | ~3,000 | 2-3小时 |
| Phase 12 (最终) | 全量 | 全量 | 1小时 |
| **总计** | **~130** | **~50,000** | **10-16小时** |

---

## 关键风险

1. **循环依赖**：修复一个文件的import可能触发另一个文件的import断裂，产生多米诺效应
2. **BashTool复杂度**：295个import/export，修复时可能引发大量级联修复
3. **类型系统耦合**：Tool.ts的接口定义被所有工具引用，修改它会影响全部
4. **services/mcp/auth.ts**：2,465行认证代码与OAuth/企业SSO深度耦合，可能需要整个重写
