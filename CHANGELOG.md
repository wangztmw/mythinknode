# Changelog

## 1.1.1 (2026-11-06)

修复：

- banner 版本号硬编码为 `v0.6.0`，与 package.json 不同步 —— 现统一由 `src/version.ts` 从 `package.json` 读取（`VERSION`），此后 bump 版本号 banner 自动跟随。

## 1.1.0 (2026-11-06)

自 1.0.0 以来的功能增量，向后兼容：

- **Ink TUI** —— 全新会话界面（`--tui`）：工具调用富预览、markdown/表格行内渲染、2D 屏幕缓冲、行宽与增量重绘优化。经典 CLI 仍可用 `--classic`。
- **Vision 工具** —— 图片分析：云端 `deepseek-flash` 优先，失败自动回落本地 `Qwen3-VL-8B`（自动起停，空闲 3 分钟退出）。
- **本地模型模式** —— 支持本地 OpenAI 兼容端点。
- **NodeMindTool** —— 动态工具加载：把 NodeMind 节点里的 `[config]` + `[code]` 编译成可调用工具，沙箱内运行（`analyzeImage` / `taskPrompt` / `fetch` / `zod`）。
- **会话命名** —— 改为「首句意图 + 最近五条输入意图尾缀」。
- **InferMem 落盘兜底** —— `flush(force)` + `saveAllStores` + 进程退出钩子，避免知识树丢失。

工程：

- `build`/`prepare` 自动生成 `bin/` 入口（`scripts/gen-bin.mjs`）；`bin/`、`dist/` 不再进 git 追踪。
- 新增依赖：`ink` / `ink-big-text` / `ink-gradient` / `ink-spinner` / `react` / `string-width` / `wrap-ansi`。
- 移除 docs/、Plan/ 的 git 追踪（本地保留），恢复 MIT LICENSE。

## 1.0.0 (2026-08-26)

三个独立的「记忆/知识」创新首次同台，标记 1.0：

- **Session Graph Map（NodeMind）** —— 跨会话树状经验图：原生 AI 搜索 + 逻辑树保持，失败路线比成功更有价值。
- **InferMem** —— 跨书知识 DAG：把 markdown 批量编译成带证据的知识图（`concept/definition/theorem/formula/table/case`），跨书按 `identityKey` 合并、`case` 永不合并、原文指针化、隐式边推断、便宜模型批量抽取。
- **TraitGraph** —— 会话级「思维-执行」轨迹图：节点记 `goal/plan/direction`，边记 `action→result`，走不通 `backtrack` 标死折返；模型显式记录，`T{n}` 标记索引（对齐 `S{n}` 索引 raws），Session Memory 可召回注入。

其它：

- 工具增至 16 个（新增 `Infer` / `InferQuery` / `TraitGraph`）。
- 修复 NodeMind Reflector：LLM 吐出纯中文/纯符号 title 时 slug 后 id 为空，导致 `upsertNode` 校验报错——现在容错跳过脏 attr/节点。
