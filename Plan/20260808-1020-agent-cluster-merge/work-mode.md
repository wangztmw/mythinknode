# 工作方式

## 修改前

```
主Agent 调 Agent(spawn)     → AgentTool 创建 → addMember → team Map
                            → agentLoop(subConfig).then(...)

主Agent 调 AgentTeam(check) → AgentTeamTool 读 team Map → 返回报告
主Agent 调 AgentTeam(wait_any) → 轮询 team Map → 任意完成返回

子Agent 完成 → completeMember → _notify(信号) → pendingNotifications
                                  ↓
BLOCKED         → _notify(信号) → pendingNotifications

AgentTeam 和 Agent 是两个独立工具，各持有 _tasks/_engine/_notify 静态引用
agent_team.ts 模块级 team Map + 磁盘读写函数
```

## 修改后

```
主Agent 调 Agent(spawn)       → AgentTool 创建 → engine.team.set(id, member)
                              → agentLoop(subConfig).then(...)

主Agent 调 Agent(check, id)   → AgentTool 读 engine.team.get(id) → 返回报告
主Agent 调 Agent(wait_any)    → 直接轮询 engine.team → 任意完成返回
主Agent 调 Agent(direct, id)  → member.pendingInstruction = ...
主Agent 调 Agent(kill, id)    → member.abortController.abort()

子Agent 完成 → member.status='completed' + member.output=result
              → engine.pendingNotifications.push(信号)

BLOCKED      → member.status='blocked' + member.feedback=reason
              → engine.pendingNotifications.push(信号)

/// 只有一个工具、一个状态表、一个通知队列
```

## 调用链

```
Mythinknode.ts
  → new AgentEngine(...)           ← team Map 在构造时初始化
  → initAgentTool({ engine })      ← AgentTool 拿到 engine 引用
  → startCLI(engine)

cli.ts
  → engine.flushNotifications()    ← 信号注入 sessionMessages
  → agentLoop(engine, mainConfig)  ← 主Agent 循环
  → engine.team 直接读             ← post-loop guard

AgentTool.call({action})
  → engine.team                    ← 读/写状态表
  → engine.pendingNotifications    ← push 信号
  → agentLoop(engine, subConfig)   ← 子Agent 循环
```

## 数据流

```
engine.team: Map<id, MemberState>     ← 唯一状态持有者
  │
  ├─ Agent(spawn) → .set(id, newMember)
  ├─ Agent(check) → .get(id) → 格式化返回
  ├─ Agent(wait_any) → 轮询 .values() → 找第一个非 running
  ├─ Agent(direct) → .get(id).pendingInstruction = ...
  └─ Agent(kill)   → .get(id).abortController.abort()

engine.pendingNotifications: Array    ← 信号队列
  │
  ├─ Agent 完成 → push 信号
  ├─ Agent BLOCKED → push 信号
  └─ cli.ts flushNotifications() → shift → sessionMessages
```
