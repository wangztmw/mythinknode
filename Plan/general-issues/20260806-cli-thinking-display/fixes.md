# 修复历程

## Fix 1: thinking_start 移到 acquire 之后

**文件**: `agent_def.ts` — callLLM 方法

**改前**: `thinking_start` → `lacquire` → `thinkStart` → tick

**改后**: `lacquire` → `thinkStart` → `thinking_start` → tick

**判定**: **治本**。排队时间不再被误显示为 "Thinking (0.0s)"。

---

## Fix 2: \x1b[K 清行尾

**文件**: `cli.ts` — renderProgress

**改前**: thinking_tick/thinking_end 只用 `\r` 回到行首，旧文本残留

**改后**: 追加 `\x1b[K`（ANSI EL0：擦除到行尾）

**判定**: **治本**。终端标准做法。

---

## Fix 3: tickFn 立即执行

**文件**: `agent_def.ts` — callLLM

**改前**: `setInterval` 创建后等 100ms 才第一次执行

**改后**: `setInterval` 创建后立刻手动执行一次 tickFn

**判定**: **无效**。`thinking_start` 已经写了 "(0.0s)"，tickFn 几微秒后写完全相同的 "(0.0s)"。100ms 后才更新到 0.1s。不改变任何用户可见行为。**建议删除。**

---

## Fix 4: cancelled 标志防 linger tick

**文件**: `agent_def.ts` — callLLM

**改前**: `clearInterval` 后，已在 macrotask 队列中的 tick 回调仍执行，污染终端

**改后**: `cancelled = true` 在 finally 第一行。tickFn 检查 `if (!cancelled)` 才写 stderr

**判定**: **治本**。消除 linger tick 渲染污染。

---

## 效果评估

| 现象 | 修复前 | 修复后 |
|------|--------|--------|
| 排队显示 0.0s 卡住 | 是 | 否（排队时不显示） |
| 数字不持续跳动 | 感知强烈 | 感知改善（主因已修） |
| 两个 Thinking 挤一行 | 偶发 | 已修复 |
| thinking_end 后残影 | 偶发 | 已修复 |
