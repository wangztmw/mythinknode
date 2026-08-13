# 修复计划：fetch 无超时导致 ECONNRESET 后永久挂起

> **缺陷等级**：🔴 致命 — 进程永久卡死，需手动 kill
> **影响范围**：所有 LLM API 调用（主Agent + 子Agent），与任务树系统无关
> **发现日期**：2026-08-06

---

## 一、缺陷描述

### 现象
ECONNRESET 发生后，agent 显示 "Thinking (860s) — reviewing results" 持续数分钟不动，需 Ctrl+C 强杀。两个独立 mycoder 窗口同时卡死。

### 根因（已由 3 Agent 并行调查确认）

```
retry.ts:31  fetch(url, init)          ← 无 AbortSignal/signal，无超时
    ↑ TCP 连接成功但服务器不返回数据 → Promise 永不 resolve 也不 reject
    ↑
agent_def.ts:222  await provider.call(...)  ← 无 AbortController/超时保护
    ↑ 永久挂起，finally 中的 llmLimiter.release() 永远不执行
    ↑ ConcurrencyLimiter(3) 槽位永久泄露
    ↑
session_loop.ts:142  await callLLM(...)      ← 无 try/catch（主Agent崩溃路径）
```

ECONNRESET → `isRetryable` 返回 true → 重试 3 次（100/200/300ms 退避）。第 4 次 TCP 握手成功但 DeepSeek 不回 HTTP 响应 → 永久挂起。

### 影响
- 主 Agent：进程卡死，CLI 无响应
- 子 Agent：ConcurrencyLimiter 槽位泄露，其他已在运行的子 Agent 还能继续，但新的请求排队 120s 后超时
- 两个独立窗口同时卡死 = DeepSeek 白天峰值 + 无超时 = 两个进程各自独立撞上同一问题

---

## 二、修复方案

### 修改 1：`src/llm/retry.ts` — fetch 加超时

**重写 `fetchWithRetry`**，增加两个参数：
- `perRequestTimeoutMs = 120_000`（单次请求 120s）  
- `totalTimeoutMs = 180_000`（所有重试总时长 180s）

关键设计：
```
外层 AbortController（总超时）
  └─ 超时触发 → abort 当前 fetch → catch 检测到 totalController.aborted → 直接抛出，不再重试
  
每次循环：
  ├─ 创建单次 AbortController
  ├─ 监听总超时信号（总超时 → 级联 abort 当前请求）
  └─ finally: clearTimeout(reqTimer) + removeEventListener
```

同时在 `isRetryable` 中显式加入 `AbortError`/`timeout` 的可重试判断。

**注意**：ECONNRESET 后退避从 `100 * (attempt + 1)` ms 改为指数退避 `1000 * 2^attempt` ms（1s/2s/4s）——给服务器更多恢复时间。

### 修改 2：`src/agent_def.ts` — callLLM try/finally 完善

当前 `clearInterval(tick)` 在 `provider.call()` 之后——如果 call 抛异常，tick 永久泄漏。

改为：
```typescript
let tick: ReturnType<typeof setInterval> | null = null;
try {
  tick = setInterval(...);
  const result = await this.provider.call(...);
  return result;
} finally {
  if (tick !== null) clearInterval(tick);
  this.llmLimiter.release();
}
```

`acquire()` 保持在 `try` 外部——acquire 自身抛异常（排队超时）不需要 release。

### 修改 3：`src/llm/concurrency.ts` — 定时器泄漏修复

`setInterval(5000)` 改为 `setTimeout(120000)`：
- 正常消费队列时 `clearTimeout(next.timer)` 立即清理
- 避免每 5 秒一次的空转检查

### 修改 4：`src/session_loop.ts` — agentLoop 兜底 try/catch

`agentLoop` 中 `callLLM` 调用加 try/catch，防止未预期的 LLM 错误导致 Agent 静默退出：
```typescript
try {
  const response = await (engine as any).callLLM(messages, phase, onProgress);
} catch (e) {
  return { status: 'crashed', text: `LLM call failed: ${(e as Error).message}`, roundCount: i + 1 };
}
```

---

## 三、执行监督计划

### 原则
- **改动面小**：4 个文件，~80 行改动
- **独立可测**：retry.ts 可单独测试超时/重试/总超时逻辑
- **风险可控**：不改 API 签名（新增参数带默认值），现有调用方无需修改

### Agent 布局

```
监工 Agent（验证编译 + 逻辑审查）
  │
  ├─ Worker A: retry.ts 重写（isRetryable + fetchWithRetry）
  ├─ Worker B: agent_def.ts callLLM try/finally
  ├─ Worker C: concurrency.ts setTimeout 替换
  └─ Worker D: session_loop.ts agentLoop 兜底 try/catch
```

4 Worker 并行执行，互不依赖。

### 监工验收清单

| # | 验证项 | 方法 |
|---|--------|------|
| 1 | `npx tsc --noEmit` 零错误 | 编译 |
| 2 | `fetchWithRetry` 单次超时 | setTimeout 120s → AbortError → 被 catch → 重试 |
| 3 | `fetchWithRetry` 总超时 | 3 次重试累计 > 180s → 抛出 "total timeout exceeded" |
| 4 | `fetchWithRetry` 成功路径不受影响 | 正常请求不触发超时 |
| 5 | `callLLM` tick 清理 | 模拟抛异常 → clearInterval 被调用 |
| 6 | `callLLM` limiter 释放 | 模拟抛异常 → limiter.release() 被调用 |
| 7 | `ConcurrencyLimiter` 无定时器泄漏 | release() 正常消费 → clearTimeout 调用 |
| 8 | `agentLoop` crash 不静默 | 模拟 callLLM 抛异常 → 返回 `{status:'crashed'}` |

### 代码量

| 文件 | 改动 |
|------|------|
| `retry.ts` | ~50 行（重写 fetchWithRetry + 增强 isRetryable） |
| `agent_def.ts` | ~10 行（try/finally 重构） |
| `concurrency.ts` | ~10 行（setInterval→setTimeout） |
| `session_loop.ts` | ~8 行（callLLM try/catch 兜底） |
| **合计** | **~78 行** |
