# 工作方式

## 当前工作方式（改前）

```
心跳生产：
  query_loop.ts 每 100ms → engine.events.push({type:'thinking_tick'})
  query_loop.ts 工具每 100ms → engine.events.push({type:'thinking_tick'})

渲染消费：
  pollEvents 每 80ms → while(events) shift → render → \r 覆写 stdout

输入：
  readline 'line' 事件 → resolve 第一行 → 其余行丢弃
```

## 修改后工作方式（改后）

```
心跳生产：
  query_loop.ts 每 1000ms → engine.events.push({type:'thinking_tick'})

渲染消费：
  pollEvents 每 1000ms → while(events) shift → render（tick 合并）

输入（bracketed paste）：
  stdin → 检测 ESC[200~ 开始 → 累积多行 → ESC[201~ 结束 → resolve 完整文本
```

## 调用链变化

| 函数 | 改前 | 改后 |
|------|------|------|
| `query_loop.ts` `agentLoop` 心跳 | `setInterval(..., 100)` | `setInterval(..., 1000)` |
| `query_loop.ts` `executeTools` 工具心跳 | `setInterval(..., 100)` | `setInterval(..., 1000)` |
| `progress.ts` `pollEvents` | `setInterval(..., 80)` | `setInterval(..., 1000)` |
| `cli.ts` 输入处理 | `rl.on('line')` 单行 | bracketed paste 累积多行 |

## 数据流（谁生产、谁消费、谁清理）

| 数据 | 生产 | 消费 | 清理 |
|------|------|------|------|
| `engine.events` | agentLoop/executeTools 心跳 | pollEvents → stdout | session_loop 每次 runSession 前 `length=0` |
| 输入 buffer | 自管 stdin 累积（raw/paste） | resolve 完整文本 | resolve 后清空 |

## 输入边界判定（改后核心）

```
短输入（打字）:  回车 \n 结束 → resolve 单行/累积文本
大输入（粘贴）:  ESC[200~ 开始累积，ESC[201~ 结束 → resolve 完整多行文本
                （或超长单行：不逐字符回显，直接累积到底）
```

## 风险与降级

- **bracketed paste 不可用** → 降级自管 stdin（方案 B），接受失去行编辑
- **失去行编辑体验**（方向键/历史）→ 评估 AI agent 场景下是否可接受；历史可用独立方案补
- **降频后秒数卡顿感** → 实测观察，若 1s 太卡再回调 500ms
- **pollEvents 降频后事件堆积** → tick 合并逻辑兜底，非 tick 事件仍 while 全量消费
