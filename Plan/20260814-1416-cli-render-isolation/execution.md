# 执行步骤

## Step 1: `query_loop.ts` — AgentLoopParams 加 silent

- `AgentLoopParams` 接口加 `silent?: boolean`

## Step 2: `query_loop.ts` — agentLoop 解构 + 包 if

- `agentLoop` 解构里加 `silent`
- **7 处** push 包 `if (!silent)`：
  - L161 `thinking_start`
  - L165 `thinking_tick`（心跳）
  - L180 `thinking_end`
  - L197 `thought`
- 心跳 `setInterval`（L164-166）创建也放进 `if (!silent)` 分支

## Step 3: `query_loop.ts` — executeTools 加 silent

- `executeTools` 签名加 `silent?: boolean` 参数
- 3 处 push 包 `if (!silent)`：
  - L95 `thinking_tick`（工具名 0s）
  - L99 `thinking_tick`（工具心跳）
  - L112 `tool_display`
- 工具心跳 `setInterval`（L98-100）创建也放进 `if (!silent)` 分支
- `agentLoop` 里调用 `executeTools` 时传 `silent`
- **红线**：`updateStats` 调用（L79-86）**不**包 silent

## Step 4: `query_loop.ts` — 补全 feedback 提取

- L200-206 现在只匹配 `[FEEDBACK:]`/`[BLOCKED:]`，补 `[NEED:]`/`[FOUND:]`：
  ```ts
  const nm = thoughts.match(/\[NEED:\s*(.+?)\]/);
  const fdm = thoughts.match(/\[FOUND:\s*(.+?)\]/);
  if (bm) feedback = `BLOCKED: ${bm[1]}`;
  else if (nm) feedback = `NEED: ${nm[1]}`;
  else if (fdm) feedback = `FOUND: ${fdm[1]}`;
  else if (fm) feedback = fm[1];
  ```

## Step 5: `AgentTool.ts` — subConfig 加 silent + 补 round/tool 计数 + end_turn BLOCKED

- `subConfig` 对象加 `silent: true`
- 补 `roundCount`/`toolUseCount` 更新。方案：在 `updateStats` 回调里维护两个闭包计数器，或新增 `onRound` 回调。具体实现：
  ```ts
  let round = 0, tools = 0;
  updateStats: (name, summary, output, feedback?) => {
    tools++;
    if (member.agentLoop) {
      member.agentLoop.roundCount = round;      // 每轮开始时设
      member.agentLoop.toolUseCount = tools;    // 每次工具调用累加
      member.agentLoop.lastActivity = `${name}(${summary})`;
      member.agentLoop.lastOutput = output.slice(0, 200);
    }
    ...
  }
  ```
  （round 的准确递增需在 `agentLoop` 层有轮次回调，见 Step 6）
- 后台/同步 spawn 的 `.then` 成功分支，扫 `result.text` 的 `[BLOCKED: reason]`，命中则置 `member.status='blocked'` + `member.feedback` + onNotify

## Step 6: `query_loop.ts` — 加 onRound 回调（补 round 计数）

- `AgentLoopParams` 加 `onRound?: (i: number) => void`
- `agentLoop` 每轮循环开头调 `onRound?.(i)`
- `AgentTool` 的 `subConfig.onRound = (i) => { round = i + 1; if (member.agentLoop) member.agentLoop.roundCount = i + 1; }`

## Step 7: 编译 + 烟雾测试

```bash
npx tsc --noEmit && npm run build
```

## Step 8: 手动测试 + 记录观察

- 跑一个 spawn 3+ 子 Agent 的任务
- 观察主屏是否还有屏闪/卡顿
- 子 Agent 完成通知是否正常
- `Agent(check)` 是否读到非零 round/tool 计数
- `[NEED]/[FOUND]/[BLOCKED]` 是否到达主 Agent
- 追加 observations.md

## 审查结论（已通过，需捆绑修复）

见 review.md。2 个维度审查通过，但需捆绑修复三处通路 A 缺陷（round/tool 死字段、[NEED]/[FOUND] 断链、end_turn 的 [BLOCKED]）。
