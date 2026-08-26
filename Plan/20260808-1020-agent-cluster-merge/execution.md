# 执行步骤

> 审查后补充的修复标注为 🔴高危 🟡中危

## Step 0: 修 pre-existing bug — SUB_AGENT_PROMPT 从未生效 🔴

### session_loop.ts
- `AgentLoopParams` 加 `systemPrompt?: string` 字段
- `agentLoop` 内 `callLLM` 调用加第 4 参数: `engine.callLLM(messages, phase, onProgress, params.systemPrompt)`

### agent_def.ts
- `callLLM` 签名已有 `systemPromptOverride?: string` 参数（line 159），确认可用

## Step 1: 改写 agent_def.ts

- 🔴 新增 `registerBashMember(subject, desc?): MemberState` 和 `completeBashMember(id, output)` 方法（替代 agent_team 的 addMember/completeMember）
- 🟡 保留 `MemberState.type: 'local_agent' | 'local_bash'` 字段（bash 任务不发 agentLoop）
- 把 MemberState 类型从 `agent_team.ts` 移到 `agent_def.ts`（精简字段，删 outputFile/_sessionId/group/contextFiles/description）
- AgentEngine 加 `team: Map<string, MemberState> = new Map()` 
- 删构造函数里 `deps.teamReg/addMember/completeMember` 参数和属性声明
- 删 `import type { MemberState } from './agent_team.js'`
- 🟡 完整重写 `buildSystemPrompt()` 中所有 AgentTeam 引用 → `Agent(action='xxx')`

## Step 2: 重写 AgentTool.ts

- 合并 spawn + check + wait_any + direct + kill 五个 action
- inputSchema 改为 `action` enum + 各参数的 `.describe()`
- 删 `_tasks/_engine/_notify` 静态引用，改用 `engine.team`
- 删 context_files 冲突检测 + group 参数
- `initAgentTool` 只需 `{ engine }` 一个参数
- 🟡 notification 字符串: `AgentTeam(check, ${id})` → `Agent(action='check', taskId='${id}')`
- 🟡 `member.output` 存完整文本（不截断 500），check 时输出全文
- spawn 逻辑保持：创建 MemberState → engine.team.set → agentLoop → 状态更新 → 信号通知

## Step 2.5: 更新 AgentTool/prompt.ts 🟡

- DESCRIPTION 覆盖全部 5 个 action
- 工具列表描述更新

## Step 3: 更新 CLI + 入口

### cli.ts
- post-loop guard: `(engine as any).team` → `engine.team`
- 🟡 通知字符串: `Use AgentTeam(check, ...)` → `Use Agent(action='check', ...)`
- 🟡 `(engine as any).pendingNotifications` → `engine.pendingNotifications`
- 系统提示符保持 `mtn >>>`

### Mythinknode.ts
- 删 `import { addMember, completeMember, getTeam } from './agent_team.js'`
- 删 `import { initTaskTool } from './AgentTeamTool.js'`
- 🔴 `initBashBg` 调用改为传 `engine.registerBashMember` 和 `engine.completeBashMember`
- `new AgentEngine(provider, tools, config)` 不再传 deps
- `initAgentTool({ engine })` 替代原来的三行注入

### core/index.ts
- 删 `AgentTeamTool` 的 import 和注册

## Step 4: 删除旧文件

- `rm src/agent_team.ts`
- `rm -rf src/tools-v2/agent/AgentTeamTool/`

## Step 5: 编译 + 残留检查

```bash
npx tsc --noEmit && npm run build
grep -r "agent_team\|AgentTeam" src/  # 应零残留
```

## Step 6: 端到端验证

启动 mtn，测试：
1. spawn 3 个后台 Agent 搜不同主题
2. Agent(wait_any) 等任意完成
3. Agent(check) 读完整报告
4. 🟡 确认报告不截断（之前截 500 字，现在完整返回）
5. 验证信号通知格式: `Agent(action='check', taskId='xxx')`
