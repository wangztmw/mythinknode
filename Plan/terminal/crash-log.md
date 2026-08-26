# Mycoder → Terminal.app 崩溃：全量记录

> **创建时间**：2026-08-03
> **崩溃事件**：Terminal.app PID 3510 在 24 分钟内 SIGTRAP 崩溃
> **Incident ID**：751A7ED6-1A73-4345-BB9B-04CDBF5FE061

---

## 一、崩溃事实

```
Process:             Terminal [3510]
Path:                /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
Version:             2.15 (470.2)
Exception Type:      EXC_BREAKPOINT (SIGTRAP)
Termination Reason:  BUG IN CLIENT OF LIBMALLOC: memory corruption of free block
Hardware:            Mac14,2 (MacBook Air M2)
OS:                  macOS 26.6 (25G72)

Launch Time:         2026-08-03 06:38:35
Crash Time:          2026-08-03 07:02:30
运行时长:             24 分钟

Triggered by Thread: 0 (com.apple.main-thread)
崩溃位置:             libsystem_malloc.dylib → _xzm_xzone_malloc_freelist_outlined
触发路径:             SwiftUICore → _ShapeStyle_Pack.animatableData → NSView 布局递归 8 层

Terminal MALLOC:      108.5 MB（正常值 10-20MB）
VM 总量:              3.0 GB
```

---

## 二、崩溃根因

### 直接原因

macOS Terminal 2.15 的 SwiftUI 文本渲染引擎在处理**超出终端宽度的单行长行**时，布局算法不收敛，进入 8 层递归。递归期间 nano malloc zone（<256B 小对象分配区）频繁分配/释放 → 空闲块链表腐败 → libmalloc 检测到元数据损坏 → 主动 SIGTRAP。

### 触发条件

Mycoder 通过 `mdToANSI` 和 `console.log` 向 PTY 写入含超长行（> 终端宽度）的文本。LLM 返回的宽表格是主要的超长行来源。`mdToANSI` 的表渲染逻辑（`padEnd(20)`）不限制输出宽度，多列表格可以产生 300+ 字符的宽行。

### 根本矛盾

Mycoder 假设终端是一个可以处理任意宽度文本的字符网格（Unix PTY 模型），macOS Terminal 实际上是一个用 SwiftUI 实现的、对超长行布局敏感的 GUI 应用。两种模型的阻抗失配。

### 辅助因素

输入端（IME 语音输入一次性 commit 大块文本，通过 PTY ECHO 等价于一次大块输出）和输出端可能在 Terminal 文本缓冲区中发生双向碰撞，加剧了渲染管线的压力。但这不是必要条件——单行长行本身就是充分条件。

---

## 三、完整对话记录

### 第一轮：崩溃报告分析

**用户**：使用 Mycoder 过程中 Terminal 经常崩。提供了完整崩溃报告。问 Mycoder 还有什么优化空间。

**AI**：分析了 6 个文件（agent.ts、cli.ts、ansi.ts、BashTool.ts、task.ts、AgentTool.ts），指出是 Terminal.app 崩溃而非 Mycoder 进程。崩溃根因是 `BUG IN CLIENT OF LIBMALLOC: memory corruption of free block`，在 SwiftUI 的 shape style animation 渲染中触发。Terminal MALLOC 108MB 是异常信号。创建了 `Plan/tool/terminal-stability.md`，提出四层输出控制方案。

### 第二轮：要求深挖根本矛盾

**用户**：要求在 Plan 里单开文件夹，找出根本原因和根本矛盾。

**AI**：创建 `Plan/terminal/` 文件夹。写了 `root-cause.md`（Unix PTY 字节流 vs SwiftUI 视图树的阻抗失配）、`crash-trace.md`（T0→T6 逐帧还原）、`fix-plan.md`（四层输出控制：行宽 ≤200、输出 ≤4000、节流 16ms、突发降级 10KB/s）。核心结论：Mycoder 把终端当无状态字符流，Terminal 是有状态的 SwiftUI 应用。

### 第三轮：发现输入端也会触发

**用户**：使用豆包输入法语音输入到 CLI 时 Terminal 卡住。指出可能输入端也敏感。

**AI**：创建 `input-trigger.md`。分析语音输入 → IME commit → PTY ECHO → 回显大块文本 → 等价于一次输出。输入回显和程序输出共享同一条 SwiftUI 渲染管线。双向碰撞是最危险的时序。在 `fix-plan.md` 追加了两层输入防护（50ms 启动延迟 + 2000 字符输入上限）。

### 第四轮：指出绥靖政策

**用户**：魔法参数是绥靖政策，治标不治本。要求从终端渲染技术基础思考，到底该用什么技术。

**AI**：创建 `terminal-technology.md`。分析了四条路线（交替屏、viewport 管理、pager 组合、日志分离）。推荐 B1 交替屏（alternate screen）作为治本方案——因为交替屏没有 scrollback，渲染面从 O(N) 变为 O(1)，崩溃条件消除。但代价是用户失去原生 scrollback。

### 第五轮：纠正方向

**用户**：想要滚动看到所有内容。Claude Code 是交替屏吗？

**AI**：验证 Claude Code 不是交替屏——它跑在主屏上，输出完全可滚动。重新审视发现 Claude Code 和 Mycoder 的唯一实质差异是**行宽约束**：Claude Code 用 Ink + Yoga 布局引擎，所有文本组件自动被终端宽度约束折行，天然不会产生超长行。Mycoder 缺失这个约束，导致 LLM 输出的宽表格触发 Terminal 布局递归。创建 `corrected-fix.md`，方案改为终端宽度感知的自动折行（35 行代码）。这是真正的治本——保证没有任何一行超出终端宽度。

### 第六轮：队列方案讨论（当前）

**用户**：提出维护一个输入输出队列，输入只能按序处理，输出只能按序渲染，起到缓冲作用。要求客观评估。另外要求：用删除线标记废弃方案（不物理删除），新建崩溃全量记录文件。

**AI**：
- 队列方案评估：解决双向碰撞（输入端和输出端同时写入 PTY），但不解决根本问题（超长行触发布局递归）。队列是好的缓冲机制，配合折行是完整防御。
- 文档整理：用删除线标记 `fix-plan.md`（魔法参数）和 `terminal-technology.md`（交替屏）为废弃方案。

---

## 四、方案演进轨迹

| 版本 | 方案 | 核心思路 | 结论 |
|------|------|---------|------|
| V1 | 四层魔法参数 | 控制输出，不踩 Terminal 崩溃阈值 | ❌ 治标不治本，参数无理论依据 |
| V2 | 交替屏 | 换个没有 scrollback 的屏幕，渲染面 O(1) | ❌ 过度设计，牺牲了用户要的 scrollback |
| V3 | **边界折行** | 确保无超长行触发 Terminal 布局递归 | ✅ 当前采纳。Claude Code 同等保障 |
| V4 | 输入输出队列 | 串行化，防止双向碰撞 | ⏳ 评估中。解决辅助攻击面，不解决主因 |

---

## 更新日志

| 日期 | 事件 |
|------|------|
| 2026-08-03 06:38 | Terminal 启动，Mycoder 开始运行 |
| 2026-08-03 07:02 | Terminal.app 崩溃，Incident ID: 751A7ED6 |
| 2026-08-03 ~07:04 | 用户分享崩溃报告，开始诊断 |
| 2026-08-03 ~07:30 | 完成根本矛盾分析（root-cause.md + crash-trace.md） |
| 2026-08-03 ~08:00 | 用户发现输入端语音输入也会触发，追加 input-trigger.md |
| 2026-08-03 ~08:30 | 用户指出魔法参数是绥靖，要求从技术基础思考 |
| 2026-08-03 ~08:55 | 提出交替屏方案（terminal-technology.md） |
| 2026-08-03 ~09:10 | 用户指出 Claude Code 不是交替屏且想要 scrollback，纠正为折行方案 |
| 2026-08-03 ~09:30 | 用户提出队列方案，进行评估 |
| 2026-08-03 ~09:45 | 折行方案实施完成 |
| 2026-08-03 ~10:00 | 事后复盘（post-mortem.md） |
| 2026-08-03 ~10:30 | 代码重构：term-wrap.ts + src/cli/ 目录化 |
| 2026-08-03 ~11:00 | Phase 55：事件驱动 stdin + 输入队列 |
| 2026-08-03 ~11:20 | 修复 term-wrap.ts ANSI 跳过逻辑 bug |
| 2026-08-03 07:58 | 第三次崩溃，Incident ID: C7217267 |
| 2026-08-03 ~12:00 | ECONNRESET 调查：keep-alive → retry.ts |
| 2026-08-03 ~13:00 | Web工具超时反馈 + CoT + WebSearch prompt |
| 2026-08-03 ~13:40 | Keep-alive 优化 |
| 2026-08-03 ~14:00 | session.ts 会话持久化 |
| 2026-08-03 ~14:30 | 实时思考计时 |
| 2026-08-03 ~15:00 | Claude Code 多 Agent 设计调研 |
| 2026-08-03 ~15:30 | **Phase 52 实施**：LLM 并发信号量 |
| 2026-08-03 ~16:00 | **Phase 56 实施**：Task 系统升级 |
| 2026-08-03 ~16:30 | 全量同步 Notion |

### 三次崩溃对照（最终版）

| # | 时间 | 异常 | 根因 | 责任方 | 修复 |
|---|------|------|------|--------|------|
| 1 | 07:02 | SIGTRAP / malloc corruption | Mycoder 输出超长行 → SwiftUI 布局递归 | Mycoder | term-wrap 折行 |
| 2 | — | 输入冻结 | 事件驱动 stdin 使 readline 始终 active，PTY 缓冲区满 | Mycoder | rl.pause() + drain |
| 3 | 07:58 | **SIGBUS** / protection fault | **term-wrap 的 ANSI bug 产出畸形字节 → 污染 Terminal 缓冲区 → 输入时引爆** | Mycoder | 修复 ANSI 跳过逻辑 + rl.pause() |

### 第三次崩溃详细分析

**表面现象**：`IMKInputSession_Modern insertText` → `_platform_memmove` → SIGBUS

**初始判断（错误）**：Apple Terminal 的 IME 文本插入 bug，Mycoder 无关，只需加输入截断防御。

**用户的观察推翻了这个判断**：用户说"输出结束之后，我输入了一点点内容，然后就什么都没有动，自然就崩了"。这说明不是大量输入触发的——输入一点点就炸，说明 Terminal 的缓冲区在输入之前就已经腐败了。

**真因**：输出端才是源头。

```
agent.run() 大量输出期间:
  → readline 处于 active 状态（事件驱动模式）
  → readline 间歇性写光标控制序列: \x1b[0G（光标归位）、\x1b[K（清除行）等
  → 有 bug 的 term-wrap 的 breakLine() 只跳过 'm' 结尾的 SGR 序列
     → \x1b[0G 被错误处理: 跳过 G 之后继续吞正常字符
     → 产出畸形字节写入 PTY
  → Terminal 的 ANSI 解析器收到畸形字节
     → 内部文本缓冲区逐渐腐败
  → 输出结束
  → 用户输入一点点内容
  → Terminal 的 insertText → memmove 读到已腐败的缓冲区 → SIGBUS
```

**为什么不是输入量的问题**：用户只输入了"一点点"——可能只是一个字。但 Terminal 的缓冲区已经被污染了，任何写入都会炸。大量输入不是必要条件，已腐败的缓冲区才是。

**为什么旧代码没问题**：旧代码用 `rl.question()` 同步模式，readline 在 agent 处理期间不处于 active 状态，不发光标控制序列。所以不会产生畸形字节，Terminal 缓冲区不会腐败。

**双重修复**：
1. term-wrap 的 `breakLine` 和 `stripANSIWidth` 修复：正确识别所有 ANSI 终止字母（`m`、`G`、`K`、`h`、`l` 等），不再产出畸形字节
2. `rl.pause()` 在 agent 处理期间：readline 完全静默，不发任何控制序列，从源头消除交互可能
