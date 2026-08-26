# 设计方案

## 核心矛盾回顾

五份崩溃报告全部是 Terminal.app 的 CoreGraphics/Metal 渲染层 malloc 内存损坏（`BUG IN CLIENT OF LIBMALLOC`），无一帧在我们代码。触发条件是「屏幕内容复杂 + 重绘」。

pty 模型下，程序无法读回终端已显示内容，也无法关掉 Terminal 的渲染层。唯一能做的是：**让程序完全接管屏幕内容**——程序自己维护缓冲，屏幕上只显示可控的简单内容。

## 方案：alternate screen + 内存滚动缓冲（全屏重绘模型）

### 架构

```
┌─────────────────────────────────────────┐
│ 内存缓冲（大，权威）                      │
│   lines: string[]  ← 全部历史输出（含换行）│
│   scrollPos: number ← 当前视窗起始行      │
└─────────────────────────────────────────┘
         │ 程序完全控制渲染
         ▼
┌─────────────────────────────────────────┐
│ 备用屏（alternate screen）                │
│   历史可视窗口：lines[scrollPos..]        │
│   状态行（thinking 进度，可选）            │
│   输入行（PROMPT + 折行后的 chars，固定底）│
└─────────────────────────────────────────┘
```

### 统一渲染模型（关键简化）

```
render() {
  清屏 \x1b[2J\x1b[H
  画历史可视窗口（lines[scrollPos..]）
  画状态行（thinking 进度）
  画输入行（PROMPT + 折行后的 chars）
  光标定位到输入行 cursor 位置
}
```

**任何变化（输入/输出/滚动）都调 render() 全屏重绘。** 代价 O(viewport)（几十行），不是 O(全部历史)。

### 为什么全屏重绘比增量更新更简单

现有输入层用 `renderedLines/cursorPos/screenCol` 做增量更新（上移清屏 + 光标定位），这套逻辑已经证明易出 bug（"复制换行"、"字符消失"都是它）。

全屏重绘模型**删掉**这些易错的增量状态：
- 不再需要 renderedLines（上移几行）
- 不再需要 cursorPos/contentLines（算软折行行列）
- 不再需要 screenCol（屏幕光标列）
- 每次 render 从头画，屏幕状态永远正确

### 关键组件

1. **备用屏切换**：启动 `\x1b[?1049h`，退出 `\x1b[?1049l`
2. **内存缓冲**：`OutputBuffer` 类，`append` / `scroll` / `clear`
3. **全屏重绘**：`render()` 统一入口
4. **滚轮事件**：SGR 鼠标模式，`\x1b[<64;...M`（上）/`\x1b[<65;...M`（下）→ scroll
5. **输入行固定底部**：不随滚动移动

### 数据流

```
stdout 输出 → 不再直接写屏幕，而是进 OutputBuffer.append()
  → 触发视窗重绘（只画可视部分）

stdin 输入 → 进 chars/cursor（现有输入层，不动）
  → 输入行固定底部渲染

滚轮事件 → scrollPos 增减 → 重绘视窗
```

## 关键决策

### 1. 输出也要进缓冲（不只是输入）

之前只重写了输入层。本方案把**输出层**也接管：Agent 的回复、工具日志、progress 事件，全部先进 OutputBuffer，再统一渲染到备用屏。这样屏幕内容完全由程序控制。

### 2. 滚动用鼠标滚轮（SGR 模式）

- `\x1b[?1000h`：启用鼠标按下/释放报告
- `\x1b[?1006h`：SGR 扩展模式，滚轮报告为 `\x1b[<64;col;rowM`（上）/ `\x1b[<65;col;rowM`（下）
- 程序解析这些序列，调整 scrollPos
- 风险：鼠标模式开启后，普通点击也会进 stdin，要正确忽略

### 3. 输入行与历史分离

输入行固定在底部（不随滚动移动），历史在上方滚动。这需要：
- 用 scroll region（DECSTBM `\x1b[top;bottom r`）把屏幕分成「历史区」和「输入区」
- 或者手动计算：每次重绘，历史画在上方 N-1 行，输入画在最后一行

倾向 scroll region（更干净，Terminal 原生支持局部滚动）。

## 文件变化

| 文件 | 变化 |
|------|------|
| `src/cli/output-buffer.ts` | **新建**：OutputBuffer 类，内存缓冲 + 滚动 + 视窗渲染 |
| `src/cli/cli.ts` | 改：renderResult/renderProgress 走 OutputBuffer；备用屏切换；滚轮监听 |
| `src/Mythinknode.ts` | 改：启动进备用屏，退出恢复 |

## 风险与降级

- **滚轮事件复杂**：鼠标 SGR 模式解析易错。降级：滚动先用键盘（PgUp/PgDn/方向键上下），滚轮后续加。
- **备用屏下 paste 行为**：需验证 bracketed paste 在备用屏下是否仍工作。
- **progress 实时更新**：thinking 进度原本用 `\r` 原地覆写，进缓冲后要改为"最后一行原地更新"，需特殊处理。

## 验证方案

1. `npx tsc --noEmit` 零错误
2. 启动进备用屏，对话正常
3. 多轮对话后，滚轮上下滑回看历史
4. 超长输入 + 折行，观察是否还崩 Terminal
5. `/exit` 退出，主屏 scrollback 恢复
