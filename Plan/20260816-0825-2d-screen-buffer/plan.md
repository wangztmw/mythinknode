# 方向 B：二维屏幕缓冲（cell-grid diff 渲染 + sink 抽象）

> 状态：规划中 · 日期：2026-08-16
> 备份：git tag `backup-before-2d-screen-buffer`（指向 8a0c8cc，可随时回滚）
> 关联：memory `terminal-crash-root-cause`、Notion「状态行 diff」「Terminal 崩溃最终诊断」

## 新增：B 的真正价值 = 完整模型 + sink 抽象（2026-08-16 补充）

用户实测发现：**崩溃触发器是「一次输出的换行数（滚动爆发）」，不是写次数**。批量写（A）只减少 write 调用，减少不了滚动，故不治本。

但 B 的价值被重新框定：**grid 是完整内容模型，sink 只是一层转换**。

```
完整内容模型（cell grid）       ← B 建的是这个
        ↓ diff（新旧对比）
      变化集（patches）
        ↓ sink（一层转换）
   ┌─────┴─────┐
 主屏 sink       备用屏 sink
（native 滚动）  （光标重绘 + 自实现 scrollback）
```

有了 grid，备用屏不是「重写渲染」而是「换 sink」；并可用 grid 历史自实现 scrollback，找回备用屏丢的原生 scrollback。**这是唯一能让原生 Terminal.app 不崩的完整路线。**

执行顺序：B 第一步（CellGrid+Diff+sink）→ 主屏 sink（迁移现有渲染，行为不变）→ 备用屏 sink（避开滚动崩溃 + 自实现 scrollback）→ Terminal 实测。

---

## 一、方向 B 是什么

把「往终端写字节流」彻底改成「维护一块内存里的字符网格，diff 后只写变化的部分」——也就是 Claude Code 的 Ink 渲染器的做法。

**现在（字节流，一行一行写）**：

```
代码 → 生成字符串/转义序列 → process.stdout.write → 终端
```

每次心跳、每行结果都是一次独立写，终端就重绘一次、滚动一次。

**方向 B（网格 + diff）**：

```
代码 → 更新内存网格 cells[row][col] = {字符, 样式}
     → diff 新网格 vs 旧网格
     → 只 emit 变化的 cell（带光标移动）→ 一次 process.stdout.write
```

网格示意（每 cell 一个字符 + 样式）：

```
row0: ●   T h i n k i n g   ( 2 . 4 s )   …
row1: r e s u l t   t e x t   …
row2: m y t h i n k n o d e   > > >
```

秒数 `2.4s→2.5s` 只有 row0 的 `4`→`5` 一个 cell 变，diff 就只写那一个字符；结果 100 行进来，diff 把新行攒成一次写。

**它不是「优化写」，而是「没变的东西根本不写」。** 之前做的状态行 diff 是这个思路的 1 行缩小版；二维缓冲是把**整屏**都变成这个模型。方向 B 做完后，会统一取代「状态行 diff」和「批量写」两个补丁。

---

## 二、为什么要做方向 B

### 根因回顾

Terminal.app 崩溃（SIGTRAP，`BUG IN CLIENT OF LIBMALLOC`）的真实机制：**每次 PTY 写入 → Terminal 重绘一次 → 在 256 字节 nano 池里分配/释放小对象 → 池子只碎不恢复 → 累积到阈值就崩**。写频越高崩越快。

### 为什么「写得更少」是唯一正解

1. **用户实证**：少量写 = 聊很多轮不崩；大量写 = 3 轮崩。
2. **Claude Code 有心跳却不崩**：因为它用 Ink 的 cell-diff，每秒只写变化的几个 cell（24000 cell 只写 3 cell）。
3. **我们的补丁不够**：状态行 diff 只覆盖了心跳，结果输出（大头）仍然一行一写；批量写只是「攒批」，不解决「整行重写」。

### 方向 B 的价值

| 维度 | 现状（字节流 + 补丁） | 方向 B（网格 diff） |
|------|---------------------|--------------------|
| 心跳 | 只写变化字符（已做） | 自动（diff 一个 cell） |
| 结果输出 | 一行一写 | 一次写（diff 新行） |
| 编辑重绘 | `\x1b[J` 全屏清 | 只写变化的 cell |
| 光标漂移 bug | 靠几何追踪 | 网格即真相，天然无漂移 |
| 写次数 | 高 | 最低（Claude Code 同款） |

一句话：**这是唯一能真正「在原生 Terminal.app 里对标 Claude Code 不崩」的路线**，其他都是缓解。

---

## 三、方向 B 的具体做法

### 3.1 核心三件套（纯逻辑，先做、可单测）

**① CellGrid（`src/cli/render/cell-grid.ts`）** — 二维网格

- 每 cell = `{ ch: string, style: number }`（style 位掩码：bold/color）。
- 网格高度 = 终端行数，宽度 = 终端列数（显示列，CJK 占 2）。
- 操作：
  - `write(row, col, text, style)` — 从 (row,col) 写入字符串（按 charWidth 推进列）。
  - `clearRow(row)` / `clearAll()`。
  - `scroll(n)` — 顶部 n 行滚出，下方行上移（scrollback 语义）。
  - `setCursor(row, col)` — 记录输入光标。

**② Diff（`src/cli/render/diff.ts`）** — 逐 cell 比较

- `diff(prev: Grid, next: Grid): Patch[]`。
- Patch = `{ row, col, cells: Cell[] }`（同一行上一段连续变化的 cell）。
- 优化：逐行比较、只扫变化行、相邻变化 cell 合并成一段。

**③ Emitter** — Patch → ANSI

- 每个 patch：`\x1b[{row+1};{col+1}H`（光标定位）+ 文本 +（样式变化时）SGR。
- 相邻同行 patch 合并成一次写。
- 最终整帧一次 `process.stdout.write`。

### 3.2 渲染原语迁移（把「写字节」改成「写网格」）

保留几何逻辑（`term-wrap` 的 charWidth/wrapLine、`input-geometry` 的 contentLines/cursorPos/foldInput、`input-model` 的状态机），只换「输出到终端」这一层：

| 原语 | 现在（写字节） | 改成（写网格） |
|------|--------------|--------------|
| `printPrompt` | emit prompt | 网格底部写 prompt |
| `appendInput` | emit 折行 chunk | 网格底部追加 |
| `rewriteInput` | `\x1b[J` 全屏清 | 覆盖网格输入行 |
| `submitInput` | emit `\n` | 网格输入块定稿 |
| `beginStatus`/`overwriteStatus` | `\r` + diff | 网格状态行覆盖 |
| `writeLines` | 一行一 emit | 网格追加输出行 |
| （新增）输出超屏 | 终端自动滚 | `grid.scroll(n)` |

每个原语更新网格后，统一走 `diff → emit`。

### 3.3 关键难点（逐个攻破）

1. **滚动**：输出超过网格高度 → `scroll(n)` 顶部滚出，diff 自动处理视觉更新。
2. **CJK 双宽**：一个中文字占 2 个显示列；`write()` 按 charWidth 推进列，diff 的光标定位用显示列。
3. **输入光标**：编辑器光标 = 网格坐标；`cursorPos` 已返回 {line, col}（显示列），直接映射。
4. **样式编码**：bold/color 打包进 cell.style；Emitter 在样式变化处写 SGR。

### 3.4 分步实施（增量，每步可测、可回滚）

| 步 | 内容 | 产出 |
|----|------|------|
| 1 | CellGrid + Diff + Emitter 纯逻辑 | 单测：网格写/清/滚、diff 正确性 |
| 2 | 迁移**输出路径**（writeLines/结果/工具展示）到网格 | 结果输出写次数 N→1 |
| 3 | 迁移**状态行**（beginStatus/overwriteStatus）到网格 | 心跳 diff 由网格统一处理 |
| 4 | 迁移**输入块**（prompt/append/rewrite/submit）到网格 | 编辑重绘不再 `\x1b[J` |
| 5 | 滚动 + CJK 双宽收尾 | 全屏语义正确 |
| 6 | 删除旧的 emit 直写路径 + 状态行 diff 补丁 | 单一渲染模型 |

### 3.5 文件改动

- 新增：`src/cli/render/cell-grid.ts`、`src/cli/render/diff.ts`。
- 改造：`src/cli/render/screen-state.ts`（改成持有 grid + diff）、`src/cli/render/renderer.ts`（写网格）。
- 保留不动：`term-wrap.ts`、`input-geometry.ts`、`input-model.ts`（几何与状态机）。

### 3.6 验证

1. 单测：网格操作、diff 正确性、CJK 双宽、滚动、样式（逐 step 加）。
2. `npm test` 全绿（保留现有 8 个测试）。
3. 字节 diff 仪：固定交互序列，断言「写次数下降 + 最终屏幕一致」。
4. **Terminal.app 手工验证**（关键）：多轮对话 + 工具调用，观察崩溃是否消失。

### 3.7 风险

- **大重写可能引入新显示 bug**：缓解 = 分 6 步增量、每步单测、保留几何层不动、备份 tag 可回滚。
- **收益仍依赖 Terminal.app 实测**：方向 B 是「最可能的正解」，但不是 100% 保证（Claude Code 同款技术、用户同款观察是强证据）。
