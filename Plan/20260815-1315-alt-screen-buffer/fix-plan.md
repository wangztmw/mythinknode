# 统一渲染出口 — 输入块精确定位重绘（路线 3）

> 状态：规划中
> 目标：主屏 + 拖选 + 滚动 + 光标编辑全保留，根治「少字 + 崩溃」

## 根因（已锁定）

输入块渲染（`redraw` 用 `renderedLines` 上移 + `\x1b[J` 清屏）和输出渲染（`renderProgress` 的 `\r` 覆写 + `renderResult` 的 `safeWrite`）**共享屏幕光标但不协调**。`renderedLines` 只被 redraw/settle/readLine 更新，但 thinking 的 `\r`、Agent 回复的 safeWrite 都移动光标却不更新它，session 多了就累积漂移，redraw 上移错行 → `\x1b[J` 清错 → 少字 → 崩溃。

## 已验证的技术事实

- ✅ `\x1b[s`（保存光标）/ `\x1b[u`（恢复光标）：可用，恢复后重写能精确覆盖旧内容
- ⚠️ DSR `\x1b[6n`（查询光标位置）：可用但**有行号偏移**（第3行后返回行=6），不可靠，不用
- ✅ 软折行边界：`col + w >= cols`（满行即折，已修）

## 方案核心

**用「保存/恢复光标」代替「renderedLines 上移」，精确控制输入块位置。**

关键改变：不再依赖 `renderedLines` 追踪「上移几行」，而是：

1. **输入块开始渲染前**：`\x1b[s` 保存当前光标位置（这是输入块第一行的位置）
2. **写输入块**：prompt + chars（折行后的内容）
3. **输入块重绘时**：`\x1b[u` 恢复到保存的位置，`\x1b[J` 清屏，重新写

这样「输入块在屏幕的绝对位置」由 `\x1b[s`/`\x1b[u` 精确记录，不依赖 renderedLines 的算术，彻底消除漂移。

## 数据流

```
readLine:
  \x1b[s                     ← 保存"输入块第一行"的光标位置
  写 prompt                   ← 输入块就位

用户打字:
  chars 更新（数据层即时）
  防抖后 redraw:
    \x1b[u                   ← 恢复到输入块第一行
    \x1b[J                   ← 清掉旧输入块（到行尾）
    写 prompt + chars         ← 重绘输入块

回车 settle:
  取 text（chars 完整）
  chars 清空
  \x1b[J + \n               ← 清掉输入块，光标到新行（准备输出）

renderProgress（thinking）:
  在新行写，\r 覆写更新时间   ← 此时输入块已清空，\r 安全

renderResult（Agent 回复）:
  safeWrite 写回复            ← 在输入块清空后的位置

下一轮 readLine:
  \x1b[s 保存新位置
  写 prompt
```

## 关键点：renderedLines 彻底废弃

- 不再需要 renderedLines 上移
- `\x1b[s`/`\x1b[u` 精确记录输入块位置
- 输出层（thinking/回复）完全在「输入块已清空」的状态下工作，不干扰输入块

## 具体改动

| 改动 | 文件 | 说明 |
|------|------|------|
| 加 `\x1b[s` 保存光标 | cli.ts readLine | 输入块就位前保存位置 |
| redraw 改用 `\x1b[u` | cli.ts | 恢复位置 + `\x1b[J` 清 + 重绘 |
| 删 renderedLines | cli.ts | 不再需要上移 |
| settle 清屏 | cli.ts | 已做，保留 |
| renderProgress 不动 | cli.ts | thinking 的 `\r` 在输入块清空后安全 |

## 风险

- `\x1b[s`/`\x1b[u` 在窄终端/滚动时是否仍精确？——需验证
- 输入块折行多行时，`\x1b[J` 清屏是否清掉历史？——`\x1b[J` 清到屏幕末尾，会清掉输入块之后的内容，但输入块在底部，之后无内容，安全

## 验证

1. 多轮对话 + 触行末折行，不再少字
2. 拖选复制正常
3. 滚轮滚动历史正常
4. 光标编辑（退格/方向键）正常
5. 豆包输入、粘贴正常
