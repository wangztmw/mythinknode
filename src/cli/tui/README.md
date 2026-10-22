# Mythinknode TUI

基于 [Ink](https://github.com/vadimdemedes/ink)（React for CLI）的两套界面：

1. **交互式会话 UI**（替代旧 CLI 聊天界面）
2. **只读仪表盘**（展示配置 / 工具 / 系统信息）

---

## 交互式会话 UI（默认）

现在无需任何参数，以下入口都会直接进入 TUI：

```bash
npm start          # 编译后的 dist
mythinknode        # bin 入口
mtn                # bin 入口
npm run dev        # tsx 源码
npm run tui:chat   # 显式指定（保留兼容）
```

回退旧 CLI：

```bash
npm run classic
# 或 MYTHINKNODE_UI=classic
# 或加 --classic
```

非 TTY 环境（管道/重定向）会自动回退旧 CLI。

- 默认走 TUI；如需旧 CLI 用 `--classic`，业务逻辑完全不变
- 实现与 `createCLI()` 完全相同的 8 个接口
  （`setBusy / readLine / renderResult / renderError / startRender / showHelp / writeLines / close`）
- 消费同一份 `ProgressEvent` 契约，实时显示 thinking / 工具执行状态
- 历史输出走终端原生 scrollback；输入框在底部原地重绘
- 支持行编辑（←/→/Home/End/Delete）、`↑↓` 历史、`Ctrl+U` 清行、`Ctrl+W` 删词、整段粘贴
- `Ctrl+C` 退出

```
✻ Welcome to Mythinknode!  v1.0.0
model  deepseek-chat · openai
› 你好
✻ Thinking (1.2s) · analyzing
⏺ Bash(ls)
  ⎿  ... 折叠 2 行
```

### 模块结构

```
src/cli/tui/
  SessionApp.tsx      组件编排
  session.tsx         事件 → LogItem 适配
  store.ts            输入/日志状态
  text/               显示宽度、折行、清洗、语义预览
  layout/             断点、限制、输入几何
  render/             欢迎框、markdown、thought、tool、status、ErrorBoundary
  theme.ts            配色
```

`src/cli/tui/**` 不依赖旧 UI 的 `src/cli/render/**` 或 `src/cli/input/**`。

### 布局限制（TUI 专属）

| 项 | 规则 |
|---|---|
| 输入可见行数 | `clamp(rows - 12, 4, 12)`；`rows < 18` 强制 4 |
| 回复正文 | 段落软换行合并；中文按字折行（避头尾）、英文按词折行；代码保留 |
| 列表/引用 | 悬挂缩进：换行续行对齐在文字/竖线之后 |
| 表格 | 列宽按内容比例分配；窄屏/多列降级为逐字段一行 |
| thought | 语义上限 4000 字符；按宽度折叠为 8 个可视行 |
| 工具预览 | 生产端 8 逻辑行 / 800 字符；按宽度显示 6 行（compact 4 行） |
| 会话断点 | `<50` narrow / `50–79` compact / `80–119` normal / `≥120` wide |
| 看板断点 | 双栏 `≥84`；logo `≥72 列且 ≥30 行`（独立于会话断点） |

---

## 只读仪表盘

## 运行

```bash
npm run tui
# 或
npx tsx src/cli/tui/index.tsx

# 展示本地推理模式
MYTHINKNODE_LOCAL=1 npm run tui
```

按 `q` 或 `Ctrl+C` 退出。

## 显示内容

| 区块 | 内容 |
|---|---|
| Header | 版本、云端/本地模式、当前模型 |
| CONFIG | Provider、Model、Base URL、脱敏 API Key、Key 来源 |
| SYSTEM | Node/OS/Arch、PID、进程运行时长、会话数、记忆文件大小、工作目录 |
| TOOLS | 当前启用的工具列表 |
| Footer | 实时时钟与操作提示 |

## 说明

- 会话 UI 的 `.tsx` 因被 `session.tsx` 传递 import 而进入 `tsc` 编译；`App.tsx` / `index.tsx`
  不在主构建图里，用 `npm run typecheck`（`tsconfig.check.json`）做类型检查。
- 看板宽度 `< 84` 时切换单栏；高度不足时隐藏大标题。
- API Key 始终脱敏显示（仅前 4 位与后 4 位）。
- 调试输入事件：`MYTHINKNODE_DEBUG_INPUT=1` 会把 chunk/累计长度写到
  `/tmp/mythinknode-tui-input.log`（不记录内容）。
