# 计划：子 Agent 双向反馈 —— 共享白板机制

> **创建时间**：2026-08-05
> **目标**：子 Agent 可以在执行期间向主 Agent 汇报进度、请求帮助、或报告任务无法完成
> **实现方式**：`agent_team.ts` 加 `feedback` 字段 —— 共享白板，不需要新的通信协议

---

## 一、三种反馈场景

### 场景 1：进度汇报

```
子 Agent 第3轮: LLM思考 "已搜索3个方向，还需要查API文档"
  → 写 feedback: "🔍 搜索了3个方向，正在查API文档。预计还需要2轮。"
  → 主 Agent 下轮 AgentTeam(list) 看到:
     ⏳ a3kf "调研React" | r3/10 | feedback: "搜索了3个方向..."
  → 决定继续等
```

### 场景 2：任务无法完成

```
子 Agent 第5轮: LLM思考 "API文档404了，这个方向走不通。需要换一个关键词重搜吗？"
  → 写 feedback: "❌ 目标API已下线(404)。建议换用社区方案。需要新的搜索方向。"
  → 写到 status: 'blocked'
  → 主 Agent 下轮 AgentTeam(list) 看到:
     ⏸ a3kf "调研React" | blocked | feedback: "目标API已下线..."
  → 主 Agent 决定: AgentTeam(direct, a3kf, "放弃API方向，搜社区方案")
    或 AgentTeam(kill, a3kf) → 重新派一个新 Agent
```

### 场景 3：任务方向需要调整

```
子 Agent 第2轮: LLM思考 "搜索结果大多是Vue的，跟用户要的React方向不对"
  → 写 feedback: "⚠️ 搜索偏向Vue生态。建议缩小搜索范围到React 19+。"
  → 主 Agent 看到 → AgentTeam(direct, "只搜React 19+相关内容")
```

---

## 二、实现

### 2.1 agent_team.ts 加字段

```typescript
export interface MemberState {
  // ... 现有字段
  feedback?: string;      // 子Agent 写的反馈消息
  feedbackAt?: number;    // 写反馈的时间戳
  status: MemberStatus;   // 现有字段，加 'blocked' 状态
}

export type MemberStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'killed';
```

### 2.2 agentLoop 每轮结束写 feedback

在 `agentLoop` 的 `updateStats` 回调中，除了写 `lastActivity`，还检查 LLM 的 `thoughts`。如果子 Agent 认为自己需要汇报 → 写 feedback：

```typescript
updateStats: (name, summary, output, thoughts) => {
  if (task?.agentLoop) {
    task.agentLoop.lastActivity = `${name}(${summary})`;
    task.agentLoop.lastOutput = output.slice(0, 200);
    // 检查是否需要反馈
    if (thoughts && (thoughts.includes('无法') || thoughts.includes('失败') || 
        thoughts.includes('404') || thoughts.includes('❌') || 
        thoughts.includes('建议') || thoughts.includes('方向'))) {
      task.feedback = thoughts.slice(0, 200);
      task.feedbackAt = Date.now();
    }
  }
}
```

**但更好的方式**：不是用关键词匹配。而是让子 Agent 的 LLM 自己决定——在 system prompt 里加一条规则：

```
你可以随时写反馈给主Agent——在思考文字中包含 [FEEDBACK: xxx] 标记。
主Agent 会在 AgentTeam(check) 中看到你的反馈。
如果任务无法完成，写 [BLOCKED: 原因]，主Agent会重新派活或给你新指令。
```

这样 LLM 自己判断什么时候该汇报、汇报什么。不需要硬编码关键词。

### 2.3 agentLoop 内提取反馈

```typescript
// agentLoop 中，每轮 callLLM 之后
const thoughts = extractThoughts(response);
// 检查 LLM 是否主动标记了反馈
const feedbackMatch = thoughts.match(/\[FEEDBACK:\s*(.+?)\]/);
const blockedMatch = thoughts.match(/\[BLOCKED:\s*(.+?)\]/);

if (feedbackMatch && updateStats) {
  updateStats(name, summary, output, feedbackMatch[1]);
}
if (blockedMatch && task) {
  task.status = 'blocked';
}
```

### 2.4 AgentTeamTool 显示反馈

```typescript
// fmtTask 中
if (t.feedback && t.status === 'running') {
  line += `\n       💬 "${t.feedback.slice(0, 80)}"`;
}
if (t.status === 'blocked') {
  line += `\n       ⚠️ BLOCKED — "${t.feedback || '未说明原因'}"`;
}
```

---

## 三、反馈后主 Agent 怎么处理

主 Agent 在 system prompt 中已有规则：

```
有后台Agent时：AgentTeam(list)→AgentTeam(check)卡住的→AgentTeam(direct)调控或AgentTeam(kill)后重试。
```

加一句：

```
如果 AgentTeam(list) 显示某个Agent状态为 blocked 或者写了反馈，
先读 feedback，再决定：继续等 / 发新指令 / 终止并重派。
```

---

## 四、文件变化

| 文件 | 改动 | 行数 |
|------|------|------|
| `src/agent_team.ts` | `MemberState` 加 `feedback`/`feedbackAt`；`MemberStatus` 加 `'blocked'` | +5 |
| `src/session_loop.ts` | `updateStats` 签名加 `thoughts` 参数；agentLoop 中提取反馈标记 | +5 |
| `src/tools-v2/AgentTool/AgentTool.ts` | `updateStats` 回调加 thoughts 参数 | +2 |
| `src/tools-v2/AgentTeamTool/AgentTeamTool.ts` | `fmtTask` 显示 feedback + blocked 状态 | +3 |
| `src/agent_def.ts` | system prompt 加反馈规则 | +2 |

总计：+17 行。

---

## 五、验证

| # | 场景 | 期望 |
|---|------|------|
| 1 | 子Agent 正常完成 | feedback 为空，状态 completed |
| 2 | 子Agent LLM 写 [BLOCKED: 原因] | 状态变 blocked，主Agent 在 AgentTeam(list) 看到 |
| 3 | 子Agent LLM 写 [FEEDBACK: 消息] | feedback 字段有内容，主Agent 看到 |
| 4 | 主Agent 看到 blocked → 发 direct | 子Agent 下轮收到 pendingInstruction |
| 5 | 主Agent 看到 blocked → kill | 子Agent 返回 '(killed)' |
