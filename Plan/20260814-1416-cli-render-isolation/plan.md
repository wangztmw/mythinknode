# 设计方案

## 核心洞察

`agentLoop()` 是主 Agent 和子 Agent 共用的循环（query_loop.ts），里面**无条件**往 `engine.events` push 渲染事件。子 Agent 的进度本应由 `member.agentLoop` 状态表承载（AgentTool.ts 已经在做），不该再进共享渲染队列。

两条数据通路目前**同时存在**：

```
子 Agent 进度
├── 通路 A（该保留）: member.agentLoop.lastActivity/lastOutput  ← Agent(check) 读
└── 通路 B（该移除）: engine.events.push(...)                  ← pollEvents 渲染主屏
```

通路 B 就是卡顿根因。方案：给 `agentLoop` 加一个 `silent` 开关，子 Agent 调用时置 true，让通路 B 静默。

## 审查发现的连带问题（必须一并修）

silent 落地后，子 Agent 可见性**完全押在通路 A 上**，但通路 A 有三个既有缺陷，silent 会放大它们：

1. **`roundCount`/`toolUseCount` 是死字段**（高危）：`Agent(check)` 恒显示 `0/10, 0 tools`，状态表半死。
2. **`[NEED]`/`[FOUND]` 从未接入解析**（中危）：改前还能靠 thought 渲染到终端兜底，silent 后彻底消失。
3. **`[BLOCKED]` 在 `end_turn` 回合无法识别**（中危）：子 Agent 最终回合的 `[BLOCKED: reason]` 不会置 blocked 状态。

因此本方案 = **silent 隔离 + 修三处通路 A 缺陷**。

## 方案：`silent` 参数贯穿 + 状态表补全 + 信号链补全

### 改动一：silent 参数（渲染隔离）

`AgentLoopParams` 增加 `silent?: boolean`。当 `silent === true`，`agentLoop` 和 `executeTools` 里所有 `engine.events.push(...)` 跳过，且**心跳 `setInterval` 不创建**。

### 改动二：补全 `roundCount`/`toolUseCount`

在 `agentLoop` 的轮次循环里更新 `member.agentLoop` 的计数。最干净的方式：新增一个 `onRound` 回调，或复用 `updateStats` 语义。最终选择见 execution.md。

### 改动三：补全 `[NEED]`/`[FOUND]` + `end_turn` 的 `[BLOCKED]` 解析

在 `query_loop.ts` 的 feedback 提取处补全三类标记；在 `AgentTool` 的完成路径扫 `result.text` 补 `[BLOCKED]` 识别。

### 具体文件

| 文件 | 改动 | 行数 |
|------|------|------|
| `query_loop.ts` | `AgentLoopParams` 加 `silent`；`agentLoop` 解构；`executeTools` 加 `silent`；**7 处** `events.push` 包 `if (!silent)`；心跳 `setInterval` 包 `if (!silent)`；feedback 提取补 `[NEED]/[FOUND]` | ~+20 |
| `tools/agent/AgentTool/AgentTool.ts` | `subConfig` 加 `silent: true`；完成路径扫 `result.text` 的 `[BLOCKED]` | +5 |
| `agent/agent_def.ts` | （可选）`MemberState.agentLoop` 计数更新入口 | +2 |

### 关键决策：哪些 push 要静默（共 7 处，非 8 处）

| push 位置 | 静默？ | 理由 |
|-----------|--------|------|
| `thinking_start` (L161) | 是 | 子 Agent 思考阶段不该上主屏 |
| `thinking_tick` 心跳 (L165) | 是 | 屏闪主因，且 setInterval 也不创建 |
| `thinking_end` (L180) | 是 | 同上 |
| `thought` (L197) | 是 | 子 Agent 思考文本不渲染 |
| `tool_display` (L112) | 是 | 子 Agent 工具执行不渲染 |
| `thinking_tick` 工具心跳 (L95/99) | 是 | 工具心跳屏闪主因，setInterval 不创建 |

**全部静默**——子 Agent 在主屏上不应有任何逐轮渲染。它的存在感只通过两条信号体现：
1. `spawn` 时主 Agent 收到的返回 `"Agent spawned: {id}"`
2. 完成/阻塞时 `engine.onNotify` 的一句话通知（走数据通路，进 LLM 上下文，**非 stdout 行**）

### 为什么 `onNotify` 通路不受影响

`onNotify` 走 `session.addNotification` → `flushNotifications` → 以 user 消息注入，这是**数据通路**不是渲染通路。它不经过 `engine.events`，所以 `silent` 不影响子 Agent 完成时的通知信号。

### 实现红线（审查共识）

- ✅ **只包 `events.push`，绝不 gate `updateStats`** —— updateStats 是状态表唯一数据源
- ✅ 心跳 `setInterval` 创建也放进 `if (!silent)`，避免空转
- ✅ push 点共 **7 处**

## 数据流变化

```
改前：
子 agent 每轮 → engine.events.push(thinking/tick/thought/tool) → pollEvents → stdout 渲染

改后：
子 agent 每轮 → (silent=true, 全部跳过 events.push + 不建心跳定时器)
             → updateStats 回调 → member.agentLoop.lastActivity/lastOutput + roundCount/toolUseCount
             → 完成时 → onNotify → session notification（进 LLM 上下文）
```

## 不做的事（避免过度工程）

- ❌ 不改 `pollEvents` 的 shift() → 游标（事件量降下来后 O(n) 已无压力）
- ❌ 不改 `mdToANSI` 性能
- ❌ 不引入新的「子 Agent 专属渲染队列」
- ❌ 不清理 `type:'error'` 既有死代码（与 silent 无关，非本方案责任）

## 验证方案

1. `npx tsc --noEmit` 零错误
2. 手动测试：跑一个需要 spawn 3+ 个子 Agent 的任务，观察：
   - 主屏是否还有多个 tick 交替闪烁
   - 子 Agent 完成时是否还能收到 "Agent xxx done" 通知（进上下文）
   - `Agent(check)` 是否能读到 lastActivity/lastOutput + **非零的 roundCount/toolUseCount**
   - 子 Agent 写 `[NEED]/[FOUND]/[BLOCKED]` 时，主 Agent 能否收到
3. 记录现象到 observations.md
