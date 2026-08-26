# 崩溃机制逐帧还原

> **隶属**：Plan/terminal/
> **基于**：2026-08-03 Terminal.app 崩溃报告 (Incident ID: 751A7ED6-1A73-4345-BB9B-04CDBF5FE061)

---

## 时间线

```
06:38:35  Terminal.app 启动（PID 3510）
          ↓  用户打开 Mycoder，开始对话
          ↓  24 分钟内：多轮 Agent 对话，大量 ANSI 输出
          ↓  Terminal scrollback buffer 逐渐膨胀
          ↓  MALLOC 从 ~20MB 涨到 108.5MB
          ↓  某次 LLM 返回含宽表格的大块回复
          ↓  mdToANSI 渲染 → console.log 输出
          ↓  Terminal PTY reader 读到数据
          ↓  Terminal 更新文本 buffer
          ↓  SwiftUI 触发重新布局
          ↓  布局计算不收敛（文本太宽），递归加深
          ↓  递归到第 8 层，某次内存分配
          ↓  nano malloc zone 空闲块元数据腐败
          ↓  libmalloc 检测到 corruption
07:02:30  SIGTRAP → Terminal.app 崩溃
```

---

## 逐帧还原

### T0：Mycoder 侧 — 渲染并输出 LLM 回复

`cli.ts:91-92`：
```typescript
const result = await engine.run(input.trim(), renderProgress);
console.log(`\n${mdToANSI(result.text)}\n[${result.ms}ms]\n`);
```

假设 `result.text` 是一个 4000 字符的 markdown 回复，包含一个 6 列的表格。`mdToANSI()` 处理：

1. 代码块 → 灰色 ANSI 包裹
2. 粗体 → `\x1b[1m...\x1b[22m`
3. 标题 → 粗体
4. 表格 → 每列 `padEnd(20)`，6 列 = 每行 ~122 字符 + 列间 ANSI 粗体码

最终 `console.log` 写出的是一段 4000+ 字符、含几十个 ANSI 转义序列的文本，一次性写入 PTY slave 的 fd 1。

### T1：Terminal 侧 — PTY reader 读取字节

Terminal 的 `com.apple.terminal.tty-io` 线程（Thread 4）在 `__select` 上阻塞等待 PTY master 有数据。Mycoder 的 `console.log` 写入后，`select` 返回，Terminal 读取数据块。

这个线程的调用栈（截取自崩溃报告）：
```
Thread 4: com.apple.terminal.tty-io
  __select + 8
  Terminal`0x104d7f0ac  ← TTYPty::readFromChildProcess
```

### T2：Terminal 侧 — 解析 ANSI 并更新文本 buffer

Terminal 的内部文本缓冲区收到 4000 字符后：
- 解析 ANSI 转义序列，确定每个字符的前景色/背景色/粗体/斜体
- 将字符插入到对应行
- 标记这些行为 "dirty"
- 每个 dirty 行的文本被编码为 `NSAttributedString`，每种颜色/粗体变化对应一个新的 attribute run
- 对于 4000 字符含 30 个 ANSI 状态变化的文本，会创建约 30 个 attribute run
- 每个 run 在 SwiftUI 中是一个独立的视图元素

### T3：SwiftUI 侧 — 属性图更新

Terminal 的文本视图是 SwiftUI 的 `Text` 组件（或其内部等价物）。dirty 标记触发了 `@State` 变化：

```
ShapeStyleResolver.updateValue()       ← 重新计算文本样式
  → _ShapeStyle_Pack.animatableData    ← 动画数据重新插值
  → AnimatableAttributeHelper.update   ← 更新可动画属性
  → AttributeGraph::Graph::UpdateStack  ← 属性依赖图传播
  → AttributeGraph::Subgraph::update   ← 子图重新计算
  → ViewGraph.updateOutputs(at:)      ← 视图树输出层更新
```

### T4：布局递归 — 关键帧

`ViewGraph.updateOutputs(at:)` 后，SwiftUI 需要重新布局终端窗口。此时会进入 `NSView._layoutSubtreeWithOldSize`：

```
Frame 29: _NSViewLayout
Frame 28: NSPerformVisuallyAtomicChange   ← RECURSION LEVEL 8
Frame 27: _NSViewLayout
Frame 26: NSPerformVisuallyAtomicChange   ← RECURSION LEVEL 7
  ... (递归一直到 LEVEL 1)
Frame 41: -[NSView layoutSubtreeIfNeeded]
Frame 42: -[NSWindow _layoutViewTree]
Frame 43: -[NSWindow layoutIfNeeded]
```

**为什么布局不收敛？**

SwiftUI 的 Text 视图布局是一个迭代过程：
1. 提出一个宽度
2. 计算文本在这个宽度下需要多少行
3. 检查是否需要调整宽度
4. 重复

对于超长行（比如 300 字符的无空白连续字符串，或 6 列 × padEnd(20) = 122 字符的表格行被 ANSI 粗体撑宽），Text 的布局算法找不到一个既能容纳内容又不超出窗口边界的宽度。每次迭代提出新宽度 → 重新计算 → 仍然溢出 → 提出新宽度……

正常 2-3 次收敛。8 层递归说明算法发散了。

### T5：内存腐败 — 致命一击

布局递归期间，SwiftUI 不断创建/销毁小对象：
- 每个布局迭代产生新的 `CGSize`、`CGRect`、`NSAttributedString` 的临时 segment
- 每个 attribute run 的样式计算产生新的 `_ShapeStyle_Pack` 实例
- 这些对象都在 < 256 字节范围 → 分配在 nano malloc zone

递归到第 8 层时，nano zone 的空闲块链表已经被频繁的 malloc/free 搞得高度碎片化。某次 `_xzm_xzone_malloc_freelist_outlined` 遍历空闲链表时，发现一个块的元数据被踩了（前一个块的边界写越界，或者 double-free 导致的 use-after-free）。

libmalloc 的设计哲学是：**宁可崩溃，也不要静默地返回一块腐败内存**。所以它直接触发 `SIGTRAP`。

崩溃瞬间的寄存器状态：
```
x4: 0x0ba769f020  ← 这是被踩的空闲块地址
pc: 0x18a8c29f8   ← _xzm_xzone_malloc_freelist_outlined + 856
esr: 0xf2000001   ← BRK #1（libmalloc 主动触发）
```

### T6：进程终止

```
Termination Reason: Namespace SIGNAL, Code 5, Trace/BPT trap: 5
Terminating Process: exc handler [3510]
```

Terminal.app 被 macOS 的异常处理器接管 → 生成崩溃报告 → 窗口消失。Mycoder 进程因为 PTY master 端关闭，收到 SIGHUP → 退出。

整个过程中，Mycoder 自身没有崩溃——它只是失去了 PTY 连接。

---

## 为什么 108 MB 的 MALLOC 是关键线索

```
MALLOC  108.5M  46  ← 46 个独立的 malloc 分配区
```

正常 Terminal（刚启动、空 scrollback）：MALLOC 约 10-20MB，约 10-15 个区。

108MB / 46 区说明：
- scrollback buffer 存了几十万行文本
- 每行文本 = 1 个或多个 NSAttributedString + 多个 attribute run 对象
- 每个 NSAttributedString 的 run 都是独立 malloc 的小对象
- 小对象 → nano zone → 碎片化

这不是 Terminal 的 scrollback 设置问题（macOS Terminal 默认无限 scrollback）。这是一个**累积效应**——Mycoder 的 24 分钟高强度输出把 scrollback 塞到了病态体积，而 SwiftUI 文本渲染在这种体积下工作不稳定。

---

## 总结：崩溃的充分必要条件

| 条件 | 来源 | 必要性 |
|------|------|--------|
| 累积大体积输出（几十万字符） | Mycoder 25 轮迭代 | 必要——否则 scrollback 不会膨胀到 108MB |
| 超长行（>200 字符） | LLM 输出的宽表格 / 长代码行 | 必要——否则布局不会发散递归 |
| ANSI 格式（大量 attribute run） | `mdToANSI` 的粗体/灰色/表格渲染 | 充分——增加了每个字符的渲染对象数量 |
| 高频 burst 写入 | 并行工具调用 + 子 Agent 通知 | 充分——增大了 Terminal PTY reader 的压力 |
| macOS Terminal SwiftUI 架构 | Apple 的设计选择 | 必要但不可控——唯一可控的是 Mycoder 的输出 |

去掉任何一个必要条件，崩溃都不会发生。所以修复方向是：**打破"累积大体积"和"超长行"这两个必要条件。**
