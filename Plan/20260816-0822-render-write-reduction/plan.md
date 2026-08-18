# 输出写频降低总计划 — A 批量写 → B 二维屏幕缓冲

> 状态：规划中 · 日期：2026-08-16
> 备份：git tag `backup-before-2d-screen-buffer`（指向 8a0c8cc）
> 关联：memory `terminal-crash-root-cause`、Notion「状态行 diff」「Terminal 崩溃最终诊断」

## 背景（为什么做）

Terminal.app 崩溃真实机制（已实证）：**每次 PTY 写入 → Terminal 重绘一次 → nano 池碎一点 → 累积到阈值 SIGTRAP**。写频越高崩越快。

- 用户实证：少量写 = 很多轮不崩；大量写 = 3 轮崩。
- Claude Code 有心跳不崩：Ink 的 cell-diff，只写变化的 cell。
- 已做的状态行 diff（8a0c8cc）只覆盖心跳；结果输出（大头）仍一行一写。

## 执行顺序（两者都做）

1. **第一步 A 批量写**（小、快、先做）—— 把输出攒批，写次数 N→1。
2. **第二步 B 二维屏幕缓冲**（大、后做）—— 整屏 cell 网格 + diff，统一取代 A 和状态行 diff。

---

## 第一步：A 批量写（先做）

### 现状

`writeLines` / `tool_display` 每个 row 一次 `process.stdout.write`，100 行结果 = 100 次写 = 100 次重绘 + 滚动。

### 改法

攒成一个字符串，一次 emit：

```ts
writeLines(text) {
  let out = '';
  for (const row of ...) out += row + '\n';
  this.emit(out);  // 一次写
}
```

### 文件改动

- `src/cli/render/screen-state.ts`：`writeLines` 攒批。
- `src/cli/render/renderer.ts`：`tool_display` 循环攒批。

### 收益 / 风险

- 收益：结果输出写次数 N→1，是比状态行 diff 更大的一刀。
- 风险：低。每行仍 `wrapLine` 折行；`process.stdout.write` 异步缓冲。

### 验证

- 测试：一次 `writeLines` 只触发一次 emit。
- `npm test` 全绿 + Terminal.app 手工验证。

---

## 第二步：B 二维屏幕缓冲（后做）

详见 `Plan/20260816-0825-2d-screen-buffer/plan.md`（是什么 / 为什么 / 怎么做三部分）。

一句话：把「写字节流」改成「维护内存 cell 网格 + diff 只写变化 cell」，是 Ink/Claude Code 的完整做法，做完统一取代 A 和状态行 diff。

分 6 步增量实施（网格/输出路径/状态行/输入块/滚动/CJK），每步单测、可回滚。

---

## 记录

Notion「cli有关问题」下同步本计划（状态：规划中）。
