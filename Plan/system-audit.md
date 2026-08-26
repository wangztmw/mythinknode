# my-coder 全系统排查 ✅ 完成

> **时间**：2026-08-02 | **结果**：1个bug发现并修复，其余全部通过

---

## 一、Schema 安全问题

- [x] 所有工具的 Zod schema — 无 `.default()` 残留（Phase 27fix2 已修复 AgentTool）
- [x] `z.enum()` 值完整 — 仅 2 处：AgentTool(general-purpose/explore) TaskTool(list/check/wait/kill/inbox)
- [x] `z.object()` required 字段合理
- [x] `zodToJSON()` 转换 — no `.default()` means no spurious `required`

**发现**：AgentTool 的 `subagent_type: .optional().default('general-purpose')` → Zod 标记为 required → DeepSeek 不调工具。**已修复**。

## 二、依赖注入完整性

- [x] `initAgentTool` — taskRegistry, runSubAgent, buildSubAgentContext, notify ✅
- [x] `initBashBg` — createTask, completeTask, notify ✅
- [x] `initTaskTool` — taskRegistry, notify, pendingNotifications ✅
- [x] 无 null dereference（每个 init 的call()都检查 null）
- [x] 初始化顺序：tools 创建 → getAllTools → init calls ✅

## 三、Agent 循环核心路径

- [x] sessionMessages 跨轮累积（提到函数外）
- [x] flushNotifications 每轮开始前执行
- [x] pendingNotifications 只追加不重复消费
- [x] 后台 Agent → notify → pendingNotifications → flush → LLM 看到
- [x] 同步 Agent → 直接返回，不进 pendingNotifications
- [x] 子Agent tool_calls 不在主 sessionMessages

## 四、AgentTool 执行路径

- [x] spawn → taskRegistry 创建条目（含 abortController + agentLoop）
- [x] runSubAgent 接收 agentId
- [x] runSubAgent 每轮更新 agentLoop (roundCount/toolUseCount/lastActivity/lastOutput)
- [x] 同步模式：await → 返回结果
- [x] 后台模式：不await → 返回 agentId → 完成后 notify
- [x] 完成后 status='completed', endTime set

## 五、TaskTool 执行路径

- [x] list — running 显示 round/toolCount/lastActivity
- [x] check — running 显示实时进度，completed 显示完整 output
- [x] wait — 轮询 + 超时处理
- [x] kill — abortController.abort() + status='killed'
- [x] inbox — 只读不消费 pendingNotifications

## 六、子Agent 引擎

- [x] buildSubAgentContext 返回正确 messages
- [x] runSubAgent 每轮检查 abort signal (abortController.signal.aborted)
- [x] runSubAgent 使用 toolMap 路由工具
- [x] runSubAgent tool_result 正确 push（OpenAI: 逐个 tool msg, Anthropic: 批量）
- [x] 最大 10 轮限制

## 七、工具逐个审查

- [x] BashTool — schema(5 fields + 7 danger patterns), execSync/spawn, background notify
- [x] FileReadTool — absolute path, isDirectory, binary detect, 10MB limit, image/PDF/ipynb
- [x] FileWriteTool — atomic write(tmp+rename), empty warning, trailing newline
- [x] FileEditTool — duplicate detection(line+context), CRLF, empty reject, atomic write
- [x] GlobTool — ripgrep first → find fallback, sorted, truncated(500)
- [x] GrepTool — ripgrep first → grep fallback, -C context, match count, truncated(100)
- [x] WebSearchTool — DuckDuckGo Lite HTML parsing, 10 results max
- [x] WebFetchTool — fetch + HTML strip, 15s timeout
- [x] MCPTool — stub
- [x] SkillTool — stub
- [x] AgentTool — spawn, abortController, background notify, agentLoop tracking
- [x] TaskTool — 6 actions, shared registry

## 八、构建与完整性

- [x] `npx tsc` 零错误
- [x] `node dist/main.js` 可启动，Tools: 12
- [x] Provider 自动检测正常 (sk- prefix → DeepSeek)
- [x] 所有工具 isEnabled() → true

## 九、初始化与启动

- [x] import 路径全正确（无循环依赖）
- [x] getAllTools() 返回 12 工具
- [x] toolMap 正确映射
- [x] toolContext 正确创建
- [x] 所有 init 调用在 main() 中
- [x] 无 undefined 依赖传入

## 十、边界条件

- [x] 空 taskRegistry → Task(list) "(no tasks)"
- [x] taskId 不存在 → Task(check) "not found"
- [x] taskId 不存在 → Task(kill) "not found"
- [x] Agent spawn 检查 init 状态
- [x] 子Agent kill → runSubAgent 终止
- [x] 多个后台 Agent 完成 → notify 使用队列

---

## 总结

**发现 1 个 bug**：AgentTool `subagent_type: .optional().default('general-purpose')` → Zod 标记为 required → DeepSeek API 看到必填字段不知填什么 → 不调工具。Phase 27fix2 已修复。

**其余 50+ 项全部通过**。系统链路完整：Agent spawn → Task registry → runSubAgent(abort check + agentLoop update) → completeTask → notify → pendingNotifications → flush → LLM 看到。
