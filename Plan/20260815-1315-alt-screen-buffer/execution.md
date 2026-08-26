# 执行步骤

## Step 0: 前置验证（✅ 已通过）

1. ✅ 备用屏下 bracketed paste 仍工作（粘贴检测到 `\x1b[200~`/`\x1b[201~`）
2. ✅ SGR 鼠标滚轮事件能收到（`\x1b[<64;...M` 上 / `\x1b[<65;...M` 下）
3. 结论：方案可行，滚轮滚动 + 备用屏 + 粘贴三者兼容

## Step 1: 建 `output-buffer.ts`

- `OutputBuffer` 类：`lines: string[]` + `scrollPos` + `viewport`
- `append(s)`：追加内容（按换行拆行进 lines）
- `render()`：把可视窗口 + 当前输入行输出到备用屏
- `scroll(delta)`：调整 scrollPos

## Step 2: cli.ts 接备用屏

- 启动 `\x1b[?1049h` 进备用屏
- 启用 SGR 鼠标模式
- 监听滚轮事件（`\x1b[<64;...M` / `\x1b[<65;...M`）→ scroll

## Step 3: 输出走缓冲

- `renderResult` / `renderProgress` / `showHelp` 的输出，从直接 write stdout 改为 `OutputBuffer.append()`
- progress 的 `\r` 原地覆写改为"最后一行原地更新"

## Step 4: 输入行固定底部

- 用 scroll region 或手动计算，把当前输入行固定在底部
- 复用现有 chars/cursor/foldText 输入层

## Step 5: 退出恢复

- `close()` 里 `\x1b[?1049l` 恢复主屏 + 关闭鼠标模式

## Step 6: 编译 + 测试

```bash
npx tsc --noEmit && npm run build
```

## 测试观察（追加到 observations.md）
