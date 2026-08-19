# think-coder 删除清单

> 记录所有被删除的模块、文件和原因。

---

## 删除分类

### 遥测与分析（~15 文件）

| 文件/目录 | 原因 |
|-----------|------|
| `src/services/analytics/`（整个目录） | Datadog、Growthbook、事件日志——不需要任何外部上报 |
| `src/services/internalLogging.ts` | 内部日志上报 |
| `src/cost-tracker.ts` | 替换为本地计数器 |
| `src/costHook.ts` | 成本追踪钩子 |
| `src/services/diagnosticTracking.ts` | 诊断追踪 |
| `src/migrations/`（9个迁移文件） | 历史迁移脚本，新项目不需要 |

### 企业/云端功能（~80 文件）

| 文件/目录 | 原因 |
|-----------|------|
| `src/bridge/` | IDE 桥接（VSCode/JetBrains） |
| `src/remote/` | 远程会话 |
| `src/upstreamproxy/` | 代理中继 |
| `src/coordinator/` | 多 Agent 协调 |
| `src/services/remoteManagedSettings/` | 企业管理配置 |
| `src/services/settingsSync/` | 设置同步 |
| `src/services/teamMemorySync/` | 团队记忆同步 |
| `src/services/plugins/` | 插件市场 |
| `src/services/oauth/` | OAuth 认证 |
| `src/services/vcr.ts` | 录制回放测试 |
| `src/services/rateLimitMocking.ts` | 速率限制模拟 |
| `src/services/rateLimitMessages.ts` | 速率限制消息 |
| `src/services/policyLimits/` | 策略限制 |
| `src/services/claudeAiLimits.ts` | Claude.ai 限制 |
| `src/services/claudeAiLimitsHook.ts` | Claude.ai 限制钩子 |
| `src/services/mockRateLimits.ts` | 模拟速率限制 |
| `src/services/mcpServerApproval.tsx` | MCP 服务审批 |
| `src/plugins/` | 插件系统 |
| `src/tools/TeamCreateTool/` | 团队创建 |
| `src/tools/TeamDeleteTool/` | 团队删除 |
| `src/tools/SendMessageTool/` | 多 Agent 消息 |
| `src/tools/RemoteTriggerTool/` | 远程触发 |
| `src/tools/REPLTool/` | REPL |
| `src/services/AgentSummary/` | Agent 摘要 |
| `src/services/MagicDocs/` | 魔法文档 |
| `src/services/PromptSuggestion/` | 提示建议 |
| `src/services/SessionMemory/` | 会话记忆 |
| `src/services/autoDream/` | 自动做梦 |
| `src/services/voice/` | 语音服务 |
| `src/services/tips/` | 使用提示 |
| `src/services/tokenEstimation.ts` | Token 估算 |
| `src/services/toolUseSummary/` | 工具使用摘要 |
| `src/services/extractMemories/` | 记忆提取 |
| `src/services/api/` | API 层 |

### UI 层（~30 文件）

| 文件/目录 | 原因 |
|-----------|------|
| `src/ink/`（整个目录） | React/Ink 终端 UI 框架 |
| `src/components/` | React 组件 |
| `src/screens/` | 屏幕管理 |
| `src/outputStyles/` | 输出样式 |

### 不需要的内置工具（~20 文件）

| 文件/目录 | 原因 |
|-----------|------|
| `src/tools/NotebookEditTool/` | Jupyter Notebook 不常用 |
| `src/tools/LSPTool/` | LSP 太重 |
| `src/tools/PowerShellTool/` | Windows only |
| `src/tools/EnterPlanModeTool/` | 计划模式非核心 |
| `src/tools/ExitPlanModeTool/` | 同上 |
| `src/tools/EnterWorktreeTool/` | Git worktree 非核心 |
| `src/tools/ExitWorktreeTool/` | 同上 |
| `src/tools/AskUserQuestionTool/` | 交互式提问 |
| `src/tools/TodoWriteTool/` | 非核心 |
| `src/tools/BriefTool/` | 非核心 |
| `src/tools/ConfigTool/` | 配置管理非核心 |
| `src/tools/SleepTool/` | 调试用 |
| `src/tools/SyntheticOutputTool/` | 测试用 |
| `src/tools/ScheduleCronTool/` | 定时任务非核心 |
| `src/tools/ListMcpResourcesTool/` | MCP 资源非核心 |
| `src/tools/ReadMcpResourceTool/` | 同上 |
| `src/tools/McpAuthTool/` | MCP 认证非核心 |

### 其他（~20 文件）

| 文件/目录 | 原因 |
|-----------|------|
| `src/voice/` | 语音输入 |
| `src/vim/` | Vim 模式 |
| `src/buddy/` | Buddy 功能 |
| `src/moreright/` | MoreRight 功能 |
| `src/native-ts/` | 原生扩展 |
| `src/services/notifier.ts` | 系统通知 |
| `src/services/preventSleep.ts` | 防休眠 |
| `src/services/lsp/` | LSP 服务 |
| `src/keybindings/` | 键绑定 |
| `src/services/awaySummary.ts` | 离开摘要 |
