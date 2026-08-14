# 审查报告

> 审查方式：2 个 Agent 并行，各负责一个维度
> 审查时间：2026-08-14
> 结论：**需修改（轻微）——方案方向正确，捆绑修复两处既有缺陷后可执行**

---

## 维度 1：缺陷分析

### 1.1 当前缺陷是否被完整修复 — 低危（计数）/ 中危（根因确认）

- **根因命中正确**：子 Agent 与主 Agent 共用 `engine.events`，N 个子 Agent 每 100ms 心跳 + 每轮 push 事件，被 `pollEvents` 每 80ms `shift()` 后同步 `stdout.write` 阻塞事件循环。silent 把子 Agent 写入量归零，命中主因。
- **push 点实际 7 处，非 8 处**：`query_loop.ts` L95/99/112/161/165/180/197。plan.md 写"8 处"是计数笔误，需修正。

### 1.2 silent 是否引入新缺陷 — 中危（可见性）/ 低危（竞态）

- `updateStats` 与 `events.push` 是**两条独立线**，silent 不切断 updateStats。JS 单线程无数据竞态。
- **可见性退化是设计意图**，但需明确：子 Agent 完成通知走 `onNotify → session notification → 注入为 user 消息`，是"进 LLM 上下文"，**不是直接 stdout 行**。验证时不能误判"通知没上屏"。

### 1.3 降级路径 — 高危

- **`member.agentLoop.roundCount`/`toolUseCount` 是死字段**：仅在 `createAgentMember` 初始化 0，全项目无任何赋值。`Agent(check)` 和 `fmtMember` 永远显示 `Round: 0/10, Tools called: 0`。
- silent 把子 Agent 可见性完全押在状态表上，这个半死状态表就成了唯一进度入口。**这是预先存在的 bug，silent 使其后果加重。**

### 1.4 性能 — 低危（残余项）

- silent 解决"多 Agent 争抢渲染队列"主因。残余 `shift()` O(n)、同步 `stdout.write`、`mdToANSI` 属次要，事件量下降后已无压力，可延后。
- **实现细节**：心跳 `setInterval`（L98-100 toolTick、L164-166 tick）在 silent 下仍会每 100ms 空转一次。应把 `setInterval` 创建也放进 `if (!silent)` 分支，而非只包 push。

### 1.5 单点故障 / 数据丢失窗口 — 中危

- **`[BLOCKED]` 在 `end_turn` 回合无法识别**：feedback 只在 `tool_use` 分支提取（L195-209）。子 Agent 最终回合写 `[BLOCKED: reason]` 且不调工具时，走 `end_turn` → `success` → 被标 `completed`，`[BLOCKED]` 只留在 result.text，不置 `member.status='blocked'`，也不触发 onNotify。SUB_AGENT_PROMPT 明确要求"End with [BLOCKED:reason]"，这条路径实际不生效。

---

## 维度 2：模块协调性

### 2.1 调用链闭环 — 低危（通过）

- `silent` 传递链路完整：`subConfig.silent → agentLoop 解构 → executeTools(silent)`。
- `executeTools` 唯一调用点在 `query_loop.ts:208-209`，加参数只需改一处。
- `agentLoop` 4 个调用点中，子 Agent 两条（后台 L162 / 同步 L188）共用同一个 `subConfig` 对象（L126-158），加一行 `silent: true` 同时覆盖两条路径。

### 2.2 数据流闭环 — 中危

- `lastActivity`/`lastOutput` 生产于 updateStats、消费于 check/fmtMember，闭环正常（成员不清理，字段可读）。
- **`roundCount`/`toolUseCount` 是死数据**（同维度 1.3），且不要与 `LoopResult.roundCount` 混淆——后者不回写到 `member.agentLoop.roundCount`。

### 2.3 信号链 — 中危

- `[BLOCKED]`/`[FEEDBACK]` → updateStats → member.feedback → onNotify 链路**不受 silent 影响**（thought push 是纯渲染，silent 只跳过渲染行，不碰 L200-206 正则）。
- **`[NEED]`/`[FOUND]` 从未接入解析**：`query_loop.ts` L202-203 只匹配 `[FEEDBACK:]`/`[BLOCKED:]`，从不解析 `[NEED:]`/`[FOUND:]`。`AgentTool.ts:154` 注释"所有 feedback 都通知主 Agent（BLOCKED/NEED/FOUND）"与实现不符。
- 改前 `[NEED]/[FOUND]` 顶多渲染到人类终端（LLM 读不到 stdout），silent 后彻底消失——子 Agent 主动请求/发现的信息无法到达主 Agent。

### 2.4 onNotify 通路独立性 — 低危（通过，无问题）

- `engine.onNotify → session.addNotification → pendingNotifications → flushNotifications → session.messages`，全程不经过 `engine.events`。silent 只 gate events.push，不影响完成通知。plan.md 论证正确。

### 2.5 接口冲突 — 低危（通过）

- `silent?: boolean` 与现有字段无命名/语义重叠。缺省 falsy，主 Agent 两条路径（session_loop.ts:76/105）不传即零破坏。

### 2.6 死代码风险 — 低危

- silent 只关子 Agent，主 Agent 仍 emit 全部事件，渲染端 case 无"永远不触发"的分支。
- 既有死代码：`type:'error'`（progress.ts:27 + cli.ts:74-75）无任何 push 来源，与 silent 无关，可顺带清理但非本方案责任。

---

## 关键实现要点（审查共识）

| 要点 | 说明 |
|------|------|
| ✅ 只包 `events.push`，绝不 gate `updateStats` | updateStats 是状态表唯一数据源 |
| ✅ `setInterval` 创建也放进 `if (!silent)` | 否则 silent 下心跳空转 |
| ✅ push 点共 7 处 | 修正 plan.md 的"8 处"笔误 |
| ⚠️ 通知是进 LLM 上下文，非 stdout 行 | 验证时别误判 |

---

## 总判断

**需修改。** `silent` 方案本身模块协调性成立（调用链闭环、onNotify 独立、接口无冲突、不新增死代码均已通过），可作为最小改动落地。但 silent 会把子 Agent 可见性完全押在"通路 A（状态表 + 信号链）"上，而这条通路存在**两处既有缺陷**，silent 会直接放大：

1. **`member.agentLoop.roundCount/toolUseCount` 从未被写入**（高危）——silent 后 `Agent(check)` 恒显示 `0/10`、`0 tools`，状态表半死。
2. **`[NEED]/[FOUND]` 从未接入 feedback 解析**（中危）——silent 后这两类协调标记彻底消失，子 Agent 主动信息无法到达主 Agent。

另有一处边界缺陷建议一并处理：
3. **`[BLOCKED]` 在 `end_turn` 回合无法识别**（中危）——子 Agent 最终回合的 `[BLOCKED: reason]` 不会被置为 blocked 状态。

**结论：silent 方案通过，但执行时需捆绑修复上述 3 处，否则隔离渲染会让子 Agent 变黑盒。**
