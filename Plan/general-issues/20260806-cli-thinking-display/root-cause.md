# 根因分析

> 3 Agent 并行审计结论。审计范围: agent_def.ts callLLM 全路径 + cli.ts 渲染管线 + Node.js 事件循环行为。

---

## 错误直觉

"setInterval 在 await 期间不工作，所以数字不跳。"

## 事实

`setInterval(fn, 100)` 在 `await provider.call()` 期间**完全正常运行**。Node.js 事件循环在 timer 阶段和 poll 阶段（等待网络 I/O）之间交替，每约 100ms 准时触发 tick 回调。在 macOS (kqueue) 上行为一致。

---

## 真正原因（按影响从大到小）

### 原因 1（主因）：ConcurrencyLimiter 排队时间不可见

`callLLM` 的执行顺序（修复前）：

```
1. onProgress({ type: 'thinking_start' })   ← 终端显示 "Thinking (0.0s)"
2. await this.llmLimiter.acquire()          ← 可能阻塞 3-10 秒等槽位
3. const thinkStart = Date.now()            ← 时钟现在才开始
4. setInterval(tickFn, 100)                 ← tick 才开始
5. await this.provider.call(...)            ← 实际 API 调用
```

**问题**：步骤 1 写入了 "Thinking (0.0s)"，但步骤 2 阻塞时 thinkStart 还没赋值、setInterval 还没创建。用户看到 0.0s 卡住。

**修复**（Fix 3）：把步骤 1 移到步骤 2 之后。排队时间不再显示。

**遗留问题**：排队期间终端完全空白——用户不知道系统在"等槽位"还是"卡死了"。

### 原因 2（渲染污染）：linger tick 竞态

```
callLLM 末尾:
  thinking_end 写入 stderr → clearInterval(tick) → finally { release() }
  
但: clearInterval 只阻止未来的调度。已进入 macrotask 队列的 tick 回调仍会执行。
如果 LLM 响应到达和 100ms tick 几乎同时:

T0: provider.call 返回 (microtask)
T1: thinking_end "\r...5.3s...\x1b[K\n" (同步, 同一 microtask)
T2: clearInterval(tick) (同步)
T3: 但 linger tick 已在 macrotask 队列 → 执行 → 在 thinking_end 下方多写一行残影
T4: thought 输出拼接在残影上 → 视觉混乱
```

**触发概率**: 每次 callLLM 约 1-10%（100ms 间隔和 5-60s 响应时间的随机对齐）。

**修复**: `cancelled` 标志——tickFn 检查 cancelled 为 true 时 return，不写 stderr。

### 原因 3（设计特征）：多轮归零

每轮 callLLM 有独立的 `thinkStart`，从 0.0s 重新开始。工具执行期间的空白 + 下一轮从 0.0s = 用户感觉"数字在跳动"。

**不是 bug**——是 per-round 计时 vs 全局累计计时的设计选择。
