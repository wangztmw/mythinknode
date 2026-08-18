# 状态行 diff 渲染 — 降低 Terminal.app nano 崩溃的写频

> 状态：规划中 · 日期：2026-08-16
> 关联：memory `terminal-crash-root-cause`、Notion「Terminal 崩溃最终诊断：nano malloc 真相」

## Context（为什么做）

Terminal.app 崩溃的真实机制（2026-08-15 已从两份 `.ips` 实证）：不是超长行，而是 **Terminal.app 自身 SwiftUI 渲染管线的 nano malloc 池碎片化腐败（SIGTRAP）**。每次 PTY 写入都触发一次重绘 + 小对象分配，写频越高碎得越快。

用户实证（决定性证据）：**每次少量写 → 聊很多轮不崩；大量写 → 3 轮崩。**

Claude Code 也有心跳却不崩，因为它用 Ink 的 **cell 级 diff 渲染**：维护屏幕缓冲、逐格比较，**每秒只写变化的那几个字符**（spinner 跳秒时 24000 cell 只写 3 cell）。而我们的心跳是「`\r` 整行重写 + `\x1b[K` 清到行尾」，每次对终端重绘的刺激大一个量级。

## 目标

把心跳的每次写从「整行 + 清行」降到「只写变化的部分」，对标 Claude Code。

## 方案：ScreenState 状态行 diff

### 现状（`src/cli/render/screen-state.ts`）

```ts
overwriteStatus(content: string): void {
  this.emit(`\r${content}\x1b[K`);   // 每秒整行重写 + 清行
  this._statusActive = true;
}
```

### 改动

给 ScreenState 增加**状态行 diff**，记住上一次状态行内容：

1. **记住上一行**：新增 `_statusLine: string`。
2. **公共前缀 diff**（原始字符层面，ANSI 码位置稳定）：
   - 首次写（无旧行）→ 整行写（现状不变）。
   - 新行是旧行的延长（前缀 == 旧行）→ 光标已在末尾，直接写新增后缀。
   - 通用 diff → `\r\x1b[{prefixW}C` 回到前缀列 + 写新后缀 +（新行更短时）`\x1b[K` 清残留。
3. **光标移动用显示宽度**（CJK 双宽），diff 用原始字符。

### 关键边界

| 场景 | 处理 |
|------|------|
| 首次写 / 旧行为空 | 整行写（现状） |
| 秒数 `2.4s→2.5s` | 前缀到 `(2.`，只写 `5s) …` |
| `2.9s→10.0s`（变长） | 写 `10.0s) …`，不清行 |
| `10.0s→9.9s`（变短） | 写 `9.9s) …` + `\x1b[K` 清残留 |
| 名字变化（Thinking↔工具名） | 前缀落在粗体段内 → **回退整行写**（少见，可接受） |

**ANSI SGR**：粗体 `\x1b[1m${name}\x1b[22m` 的 `\x1b[22m` 在时间之前，所以秒数/标签的 diff 点永远在纯文本区，无需重注入 SGR。仅当名字变化（前缀含未闭合粗体）时回退整行写。

### 文件改动

- `src/cli/render/screen-state.ts`：`overwriteStatus` 改 diff；新增 `_statusLine` 字段 + `commonPrefix`/`activeSgrAt` 辅助。

### 验证

1. **单测**：喂心跳序列（`2.4s→2.5s→…→2.9s→10.0s→9.9s` + 名字变化），断言：
   - 每次写出的字节数 ≤ 旧整行写法；
   - 重建后的屏幕显示与旧写法一致。
2. **手工**：Terminal.app 里跑真实对话，观察崩溃是否延后/消失（用户验证）。
3. **回归**：`npm test` 全绿。

## 风险

- **显示损坏**：diff 算错 → 状态行花屏。缓解：diff 点落在粗体段内时回退整行写；单测覆盖变长/变短/名字变化。
- **收益不确定**：diff 是「最可能的杠杆」但未在 Terminal.app 实测。若无效，需进一步上 Ink 式 cell 级 diff（更大工程）。

## 记录

Notion「cli有关问题」下新增：状态行 diff — 对标 Claude Code 降写频（本计划 + 背景分析）。
