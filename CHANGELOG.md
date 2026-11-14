# Changelog

## 1.2.0 (2026-11-14)

自 1.1.1 以来的功能增量与稳定性整修，向后兼容。

功能：

- **中断当前行动** —— 运行中按 `Esc` 或 `Ctrl+C` 打断当前一轮，1.5s 内生效，会话保持完整、可直接继续对话。难点不在打断而在「平账」：LLM API 强制 `tool_use`/`tool_result` 配对，悬空会让下次请求永久 400 且 `-r` 也救不回。三道防线：`pushResults` 移到判中断之前 → `executeTools` 在已 abort 时补 `[interrupted]` 结果 → 落盘前 `repairDanglingToolUses()` 全量扫描兜底。空闲时 `Ctrl+C` 仍是退出。
- **恢复会话时重放历史对话** —— `-r` 恢复后把历史对话渲染到屏幕（用户发言 / 回复 / 工具名），自动过滤 `[S1]` 压缩摘要、`[NODE MIND]` 检索、`[TRAIT GRAPH]` 轨迹等注入内容；同一轮多个工具合并成一行。默认最多 200 条 / 4000 字符。
- **首条消息即刻命名** —— 会话目录在发第一条消息后立即改名（零 LLM 调用、离线可用），退出时再由 LLM 精修一次；精修失败保留现名，不回退时间戳。名字上限统一 15 字（有尾缀时基础名 8 + 分隔符 + 尾缀 6），按码点截断避免切出半个代理对。
- **会话选择器支持方向键导航** —— `↑↓` / `jk` / `PgUp` / `PgDn` / `Home` / `End` 移动，数字跳转保留；列表去掉 20 条截断改为全量滚动；下方预览面板显示选中会话最近 8 条内容。非 TTY（管道输入）自动降级为行读取。
- **循环预算护栏** —— 25 轮硬墙改为软预算续期：每 25 轮一次检查点，模型以「下一轮是否调工具」自行决定继续或收尾（零额外 API 调用），最多续 3 次 → 上限 100 轮。另有确定性护栏：连续 6 轮相同「工具+参数+输出」指纹 → 强停；墙钟 45 分钟 → 强停。

修复：

- **工具参数容错** —— 模型返回的 `tool_calls[].function.arguments` 常不是合法 JSON（单引号、尾逗号、裸 key、```json 围栏、注释），裸 `JSON.parse` 抛错会让整轮 `crashed`。新增分层修复 `parseToolArgs()`（原样 parse → 摘平衡块 → 修复引号/注释/裸 key/尾逗号，永不抛），修不好则把错误回灌给模型让它重发 —— 实测只浪费 1 轮即自愈。同时清掉 prompt 里教模型用单引号的坏范例。
- **TUI 输入卡死（能看见、Ctrl+C 能退，但打不了字）** —— 主循环里 `stopRender` / `renderResult` / `setBusy(false)` / `session.save()` 在 `try` 之外，任一抛异常即逃出 `while(true)`，`store.waiting` 永久停在 `false`，所有按键被静默吞掉。改为整段 `try/catch/finally`；`submit()` 的 `resolve()` 移入 `finally` 保证必达。崩溃时还原终端并打出可见错误后退出，不再装死。
- **`MaxListenersExceededWarning: 11 resize listeners`** —— ink 的 `useWindowSize()` 每个组件实例挂一个 `stdout` 监听器，日志项一多瞬时超标。改为根部单个 `WindowSizeProvider` + context 读取，峰值从 `1+N` 降到常量 2。**没有**用 `setMaxListeners(0)` 消音，以免掩盖将来真实的泄漏。
- **会话选择器字节边界缺陷** —— ① 一次 `data` 事件当一次输入 → 分帧时读不完整；② `parseInt('\x03')` 得到 NaN 被归入「开新会话」，Ctrl+C 变成开新会话；③ 非法输入静默降级丢恢复意图；④ 无相对时间，37 个会话只能靠时间戳猜；⑤ 缓冲区剩余内容被丢弃（`printf 'abc\n1\n' | mtn -r` 第二行消失）。
- **用户消息折行错乱（屏幕未满就断行）** —— 日志列表跑在 Ink `<Static>` 里，容器无 `width`，`flexGrow` 子项拿到的是终端宽度而非「终端宽度 − 前缀」，每行宽出 2 列后终端再折一次。改为自己算 `contentWidth` 并逐行渲染，`markdown` 里 4 处 `flexGrow` 一并改掉。
- **窄屏溢出** —— `Math.max(10, columns - N)` 这个「保证最小可读宽度」的兜底在 `columns < N + 10` 时反而返回比可用还宽的数值（可用 6 却返回 10）：`<Text>` 类表现为双重折行，`<Box width>` 类（表格单元格）直接溢出。抽出 `contentWidth(columns, reserved)` 统一 8 处调用点，恒 ≤ 可用；表格降级列宽另修两处（两个 `Math.max` 相加可超 `width`、值列只留 1 列放不下一个 CJK 汉字），极窄（< 5 列）放弃标签列让值独占整行。

工程：

- 测试 10 → 24 个 node 套件，断言 **889 条**（`npm test`）；另加 PTY 端到端 66 条（`npm run test:pty`，forkpty 起真进程、真 raw mode），覆盖中断、会话恢复、选择器导航、方向键、非 TTY 降级。
- 关键断言均做反向验证：把修复临时撤掉，确认测试真的会变红（工具参数 2 条、中断 2 条、折行 22 条、窄屏 19 条）。
- 会话名历史上最长 180 字（中文无分隔符一路累积），现统一 15 字；老会话在下次 `-r` 时自动缩短，不写批量迁移脚本（避免改到正在运行的会话目录与锁文件）。

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
