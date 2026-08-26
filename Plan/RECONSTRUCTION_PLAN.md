# think-coder：Claude Code 源码重构计划

> **创建时间**：2026-08-01
> **核心关键词**：Claude Code重构、源码瘦身、去遥测、独立运行、分阶段

---

## 源码概况

| 指标 | 数值 |
|------|------|
| 源路径 | `study/claude-code/claude-code-main/` |
| 总文件数 | 1905 |
| TS/TSX 文件 | 1884 |
| 总行数 | ~512,000 |
| 一级子目录 | 35 个 |

---

## 分阶段计划

### Phase 0：建立基线（当前）

**目标**：复制完整源码到 think-coder，确保原始可构建，建立变更追踪。

**动作**：
- [ ] `cp -r study/claude-code/claude-code-main/* think-coder/`
- [ ] `cd think-coder && npm install` 验证原始可构建
- [ ] 创建 `CHANGES.md` 记录所有删除和修改
- [ ] Git init + 初始 commit（保留原始基线）

### Phase 1：砍掉遥测和外部依赖（目标：-30% 代码量）

**目标**：删除所有遥测、分析、外部服务上报代码。这些代码不影响核心功能，但散布在整个代码库中。

**删除目录**：
- [ ] `src/services/analytics/` — 整个目录（datadog、growthbook、firstPartyEventLogger 等 9 个文件）
- [ ] `src/services/internalLogging.ts` — 内部日志上报

**修改文件**（删除遥测调用点）：
- [ ] `src/main.tsx` — 删除所有 analytics/sentry 初始化调用
- [ ] `src/query.ts` — 删除上报埋点
- [ ] `src/QueryEngine.ts` — 删除事件追踪
- [ ] `src/commands.ts` — 删除遥测注入
- [ ] `src/Tool.ts` — 删除工具调用上报
- [ ] `src/cost-tracker.ts` — 删除或替换为本地计数器
- [ ] `src/costHook.ts` — 删除
- [ ] `src/setup.ts` — 删除产品分析初始化
- [ ] `src/context/notifications.tsx` — 删除产品通知

**关键原则**：只删除调用，不改变函数签名（Phase 3 再统一整理）。

### Phase 2：砍掉企业/云端/IDE桥接（目标：-25% 代码量）

**目标**：删除多用户、企业、远程、IDE 集成等不需要的功能。

**删除目录**：
- [ ] `src/bridge/` — IDE 桥接（VSCode/JetBrains），~35 文件
- [ ] `src/remote/` — 远程会话
- [ ] `src/upstreamproxy/` — 代理中继
- [ ] `src/coordinator/` — 多 Agent 协调模式
- [ ] `src/services/remoteManagedSettings/` — 企业管理设置
- [ ] `src/services/settingsSync/` — 设置同步
- [ ] `src/services/teamMemorySync/` — 团队记忆同步
- [ ] `src/services/plugins/` — 插件市场
- [ ] `src/services/oauth/` — OAuth 认证
- [ ] `src/services/vcr.ts` — 录制回放测试
- [ ] `src/services/rateLimitMocking.ts` — 速率限制模拟
- [ ] `src/services/rateLimitMessages.ts`
- [ ] `src/services/policyLimits/` — 策略限制
- [ ] `src/services/claudeAiLimits.ts` — Claude.ai 限制
- [ ] `src/services/claudeAiLimitsHook.ts`
- [ ] `src/services/mockRateLimits.ts`
- [ ] `src/plugins/` — 插件系统
- [ ] `src/tools/TeamCreateTool/` — 团队工具
- [ ] `src/tools/TeamDeleteTool/`
- [ ] `src/tools/SendMessageTool/` — 多 Agent 通信
- [ ] `src/tools/RemoteTriggerTool/`
- [ ] `src/tools/REPLTool/`
- [ ] `src/services/voice/` — 语音
- [ ] `src/voice/`
- [ ] `src/vim/` — Vim 模式（可后续加回）
- [ ] `src/buddy/` — Buddy 功能
- [ ] `src/moreright/` — MoreRight 功能

### Phase 3：精简 UI 层（目标：-20% 代码量）

**目标**：用最小 CLI 替代完整的 Ink/React 终端 UI。

**删除/替换**：
- [ ] `src/ink/` — 整个终端 UI 框架（~20 文件）
- [ ] `src/components/` — React 组件
- [ ] `src/screens/` — 屏幕管理
- [ ] `src/outputStyles/` — 输出样式
- [ ] 新建 `src/ui/minimal-cli.ts` — 最简 readline 交互

**修改**：
- [ ] `src/main.tsx` → 替换为 `src/main.ts`（无 JSX）
- [ ] 删除所有 `ink` 依赖
- [ ] 保留交互式输入（readline/prompt），删除 TUI

### Phase 4：清理工具系统（目标：-10% 代码量）

**目标**：删除不需要的内置工具，保留核心。

**保留的工具**：
- [ ] BashTool — 核心
- [ ] FileReadTool / FileWriteTool / FileEditTool — 核心
- [ ] GlobTool / GrepTool — 核心
- [ ] MCPTool — MCP 代理
- [ ] SkillTool — Skill 调用
- [ ] WebFetchTool / WebSearchTool — 外网访问
- [ ] TaskCreateTool / TaskListTool / TaskUpdateTool — 任务管理

**删除的工具**：
- [ ] NotebookEditTool — Jupyter Notebook
- [ ] LSPTool — LSP 语言服务器
- [ ] PowerShellTool — Windows
- [ ] EnterPlanModeTool / ExitPlanModeTool — 计划模式
- [ ] EnterWorktreeTool / ExitWorktreeTool — Git worktree
- [ ] AskUserQuestionTool — 交互式提问
- [ ] TodoWriteTool
- [ ] BriefTool
- [ ] ConfigTool
- [ ] SleepTool
- [ ] SyntheticOutputTool
- [ ] ScheduleCronTool
- [ ] ListMcpResourcesTool / ReadMcpResourceTool
- [ ] McpAuthTool

### Phase 5：清理服务层（目标：-10% 代码量）

**目标**：精简 services 目录，只保留核心。

**保留**：
- [ ] `src/services/mcp/` — MCP 核心（去除非必需的传输类型如 sse-ide、ws-ide、claudeai-proxy）
- [ ] `src/services/tools/` — 工具执行管道
- [ ] `src/services/compact/` — 上下文压缩

**删除**：
- [ ] `src/services/AgentSummary/` — Agent 摘要
- [ ] `src/services/MagicDocs/` — 魔法文档
- [ ] `src/services/PromptSuggestion/` — 提示建议
- [ ] `src/services/SessionMemory/` — 会话记忆
- [ ] `src/services/autoDream/` — 自动做梦
- [ ] `src/services/diagnosticTracking.ts`
- [ ] `src/services/extractMemories/` — 已由记忆系统替代
- [ ] `src/services/lsp/` — LSP
- [ ] `src/services/notifier.ts`
- [ ] `src/services/preventSleep.ts`
- [ ] `src/services/tips/` — 使用提示
- [ ] `src/services/tokenEstimation.ts`
- [ ] `src/services/toolUseSummary/`
- [ ] `src/services/api/` — API 层

### Phase 6：重构入口和依赖（目标：最终 ~50K 行）

**目标**：让 think-coder 成为一个可独立构建、可运行的项目。

**动作**：
- [ ] 创建 `think-coder/package.json`（从零写，只包含必需依赖）
- [ ] 创建 `think-coder/src/main.ts` — 最小入口
- [ ] 修复所有编译错误
- [ ] 移除 TypeScript strict 导致的兼容性问题
- [ ] 验证 `npm run build && node dist/main.js` 可运行
- [ ] 端到端测试：`think-coder "ls"` 能执行并返回结果

### Phase 7：精简记忆/技能系统

**目标**：评估记忆系统，决定保留或替换。

**评估**：
- [ ] `src/skills/` — 保留核心加载逻辑，删除内置 bundled skills
- [ ] `src/memdir/` — 评估是否需要
- [ ] `src/services/compact/` — 评估最简压缩策略

---

## 需要创建的追踪文件

```
think-coder/
├── RECONSTRUCTION_PLAN.md    ← 本文件
├── CHANGES.md                ← 每次删除/修改的记录
├── CORE_KEPT.md              ← 保留的核心模块清单
├── STRIPPED.md               ← 被删除的内容和原因
└── README.md                 ← 项目说明
```

---

## 关键原则

1. **每次只切一个阶段**，完成后 `npm run build` 验证
2. **CHANGES.md 记录每一次操作**：删了什么文件、为什么、影响了哪个模块
3. **不改变保留代码的逻辑**，只删除不需要的代码路径
4. **函数签名不动**，等全部切完再统一整理
5. **如果删除导致编译失败**，先注释调用点，标记 `// TODO: STRIPPED`，Phase 6 统一清理
