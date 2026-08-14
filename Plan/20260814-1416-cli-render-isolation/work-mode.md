# 工作方式

## 当前工作方式（改前）

```
agentLoop(engine, params)                     ← 主/子 Agent 共用
  ├─ thinking_start  → engine.events.push()
  ├─ thinking_tick   → engine.events.push()  (100ms 心跳)
  ├─ thinking_end    → engine.events.push()
  ├─ thought         → engine.events.push()
  └─ executeTools
       ├─ tool tick  → engine.events.push()  (100ms 心跳)
       └─ tool_display → engine.events.push()

engine.events (共享数组)
  → pollEvents 每 80ms 轮询 → shift() → renderProgress → stdout.write
```

子 Agent 和主 Agent 走同一个 `engine.events`，无隔离。

## 修改后工作方式（改后）

```
agentLoop(engine, params)                     ← params.silent 区分
  if (!silent) {
    thinking_start/tick/end/thought/tool_display → engine.events.push()
  }
  // silent=true 时：全部跳过，仅走 updateStats 回调

子 Agent (silent=true):
  → updateStats 回调 → member.agentLoop.lastActivity / lastOutput   ← 状态表
  → 完成时 onNotify → session notification                        ← 一句话信号

主 Agent (silent=false):
  → engine.events.push() → pollEvents → stdout 渲染               ← 正常渲染
```

## 调用链变化（精确到函数）

| 函数 | 改前 | 改后 |
|------|------|------|
| `agentLoop(engine, params)` | 无条件 push | `if (!params.silent) push` |
| `executeTools(engine, response, updateStats, serial)` | 无条件 push tool tick/display | 加 `silent` 参数，`if (!silent) push` |
| `AgentTool.call()` spawn 分支 | `subConfig` 无 silent | `subConfig.silent = true` |
| `agentLoop(engine, subConfig)`（同步+后台） | 同上 | 通过 subConfig 传入 silent |

## 数据流变化（谁生产、谁消费、谁清理）

| 数据 | 生产 | 消费 | 清理 |
|------|------|------|------|
| `engine.events`（渲染事件） | 主 Agent 的 agentLoop | pollEvents → stdout | `session_loop.ts:58` 每次 runSession 前 `length=0` |
| `member.agentLoop`（子 Agent 状态） | 子 Agent 的 updateStats 回调 | AgentTool `check` action | `team` Map 存续期 |
| `session.pendingNotifications`（通知） | `engine.onNotify` | flushNotifications → messages | flush 后清空 |

## 接口冲突 / 死代码风险

- `silent` 是可选参数，缺省 `undefined`（falsy），主 Agent 调用路径**不传**就保持现状，零破坏。
- 子 Agent 唯一调用点是 `AgentTool.ts` 的 `subConfig`，加一行即可，无其他调用点遗漏。
- 不删除任何 `events.push` 代码，只包一层 `if`，回退成本为零。
