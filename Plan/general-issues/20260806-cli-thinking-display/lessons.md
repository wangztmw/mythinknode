# 可复用的经验教训

## 1. setInterval 在 await 期间正常工作

Node.js 事件循环在等待网络 I/O 时轮询 timer。`setInterval(fn, 100)` 在 `await fetch()` 期间每约 100ms 准时触发。**不要怀疑这一点。** 如果数字不跳，根因在别处。

## 2. clearInterval 阻止不了 linger callback

`clearInterval(id)` 只取消**未来**的调度。已经进入 macrotask 队列的回调一定会执行。这是一个经典的竞态窗口：Promise resolve (microtask) 和 interval callback (macrotask) 到达同一帧时，microtask 先执行（在其中 clearInterval），然后 macrotask 中的 linger callback 再执行。

**解决方案**: 加一个 `cancelled` 布尔标志，让 callback 在运行前检查。不要依赖 `clearInterval` 的时序。

## 3. 异步操作的"空白期"是 UX 杀手

`lacquire()` 排队期间终端空白 → 用户觉得卡死。任何可能阻塞超过 1 秒的异步操作之前，都应该先发出某种"waiting"信号。

**通用模式**: 在可能阻塞的异步操作前，先写一个状态行。

## 4. `\r` 回到行首，不会回到上一行

ANSI `\r` 只回到**当前物理行**的列 0。如果之前的输出有自动换行，`\r` 回不到那些行的开头。永远不要假设上一行是干净的——用 `\x1b[K` 或 `\x1b[2K` 清理。

## 5. 区分"队列等待"和"实际执行"

计时器应该只计实际执行时间，但"正在排队"这件事本身也应该有可见反馈。两者是独立的 UX 需求，不应该互相替代。

## 6. 多个 Agent 共享 ConcurrencyLimiter 的副作用

主 Agent 和子 Agent 共享同一个 Limiter(2)。主 Agent 的下一次 callLLM 可能被子 Agent 阻塞——此时"thinking"还没开始，用户看到的是空白。这个设计是正确的（计时应从获得槽位开始），但空白期需要替代性的 UX 反馈。

## 7. 修复完成后要判断是否治本

不是所有"让它不再出现"的修改都是治本的。判断标准：**这个修复是否解决了根因？还是只改变了症状的表现形式？** 例如 tickFn 立刻执行只是让 0.0s 更快被同样的 0.0s 覆盖——症状未变，只是时间窗口更短了。
