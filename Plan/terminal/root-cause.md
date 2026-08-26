# 根本矛盾：两种架构模型的阻抗失配

> **隶属**：Plan/terminal/

---

## 零、先回答一个问题：为什么别的 CLI 工具不崩？

`npm install` 输出几千行，`cargo build` 刷几分钟屏，Terminal 不崩。为什么偏偏 Mycoder 崩？

因为这三类工具的输出模式完全不同：

| 工具 | 输出特征 | Terminal 压力 |
|------|---------|--------------|
| `npm install` | 行式 spinner + 进度条，自然有磁盘/网络间歇 | 低——输出自带节流 |
| `cargo build` | 连续行式输出，每行独立，间距均匀 | 中——编译器自然限速 |
| **Mycoder** | 间歇性大块 ANSI 格式化文本（LLM 回复 3000+ 字符），块之间是 bursty 的工具调用快速序列 | **极高**——LLM 的 burst 模式 + ANSI 渲染 + 25 轮迭代 = 终端杀手 |

这不是 Mycoder 代码写得差。是 Mycoder 的**输出模式**恰好踩中了 macOS Terminal 的一个架构弱点。

---

## 一、Unix PTY 模型 vs SwiftUI 渲染模型

### Unix PTY（Mycoder 的视角）

Mycoder 做的事情非常简单——写字节到 stdout/stderr：

```
Mycoder 进程
  ├── console.log(text)      → fd 1 (stdout) → PTY slave
  └── process.stderr.write() → fd 2 (stderr) → PTY slave
                                                    ↓
                                              PTY master
                                                    ↓
                                              Terminal.app 读取
```

这是 Unix 诞生以来最基础的 IPC 机制。PTY 是一个**字节管道**。写入端只管写，读取端只管读。这个模型假设读取端能**消化任意速率和任意体积的字节流**。在 1970 年代的 VT100 物理终端上，这是成立的——物理终端的渲染速度远快于 9600 波特的串口线。

### SwiftUI 渲染管线（Terminal.app 的视角）

但 macOS Terminal 2.15（macOS 26.6）是用 SwiftUI 写的。它收到字节后做的事情：

```
PTY master read() 返回字节
  → 解析 ANSI 转义序列
  → 更新内部文本缓冲区（NSMutableAttributedString）
  → 标记受影响的行范围
  → 触发 SwiftUI @State 变化
  → AttributeGraph 传播依赖（AG::Graph::UpdateStack::update）
  → ViewGraph.updateOutputs(at:) 重新计算视图树
  → _ShapeStyle_Pack.animatableData 动画插值
  → AnimatableAttributeHelper.update 更新动画属性
  → ShapeStyleResolver.updateValue 重新解析形状样式
  → NSView._layoutSubtreeWithOldSize 递归布局
  → CA::Transaction::commit 提交到 Core Animation
  → 屏幕刷新
```

每次 `console.log()` 都可能触发这个完整管线。Mycoder 每秒可以产生几十次 `console.log()` + `stderr.write()`。

### 阻抗失配在哪儿

```
Mycoder 的假设              Terminal.app 的现实
─────────────────────       ─────────────────────
终端 = 字符网格             终端 = SwiftUI 视图树
写 = 显示                   写 = 触发响应式渲染管线
速度 = 无限                 速度 = 受限于 CPU/GPU 帧率
吞吐 = 无限                 吞吐 = 受限于 scrollback buffer 内存
ANSI = 装饰                  ANSI = 影响布局计算（粗体改变字形宽度）
```

**这就是根本矛盾。** Mycoder 按照 Unix 传统把终端当成无状态字符流，但 macOS Terminal 是一个有状态的、基于响应式 GUI 框架的应用程序。高频 + 大吞吐量时，SwiftUI 的渲染管线跟不上 PTY 的字节流速，产生恶性循环：

```
输出太快 → 渲染管线积压 → 更多内存分配排队
  → scrollback buffer 膨胀 → malloc 分配更多内存
  → 布局递归加深（因为内容更多更复杂）
  → nano malloc zone 碎片化 → 空闲块元数据腐败
  → libmalloc 检测到 corruption → SIGTRAP
```

---

## 二、为什么是 nano malloc zone

崩溃点在 `_xzm_xzone_malloc_freelist_outlined`。`xzm` = Xzone Malloc，nano zone。

macOS 的 malloc 分三个 zone：
- **nano**：< 256 字节的分配。从专用的 512GB 虚拟地址区域分配，每个指针编码了大小类信息。追求极致速度。
- **tiny**：256B ~ 1KB
- **small**：1KB ~ 15KB

崩溃在 nano zone 说明：**大量 <256 字节的小对象被急剧分配和释放**。这刚好是 SwiftUI 的特征：
- `_ShapeStyle_Pack` 的每个动画数据块
- AttributeGraph 的每个依赖节点
- Text 视图的每个 run（NSAttributedString 的 attribute run）
- 每个 ANSI 颜色变化创建一个新的 attribute run

当 Terminal 的 scrollback buffer 有 108MB 文本时，SwiftUI 渲染它需要创建**数以万计**的小对象。nano zone 的空闲块链表在这种极端碎片化下腐败了。

---

## 三、为什么是布局递归 8 层

崩溃栈中 `NSView._layoutSubtreeWithOldSize` 被调用了 8 次递归：

```
RECURSION LEVEL 8  _NSViewLayout
RECURSION LEVEL 7  _layoutSubtreeWithOldSize
RECURSION LEVEL 6  ...
...
RECURSION LEVEL 1  layoutSubtreeIfNeeded
```

SwiftUI 的布局系统在计算一个视图的 intrinsic size 时，如果内容尺寸依赖容器尺寸（比如文本换行宽度 = 窗口宽度），需要多次迭代。正常情况 2-3 次收敛。8 层递归说明：

1. 文本内容极端宽（可能是超长行 ≥ 几百字符），布局引擎尝试了多个宽度都无法收敛
2. 或者 ANSI 格式导致 SwiftUI 的 attribute run 太多了，每个 run 的尺寸独立计算导致布局算法发散

最可能的触发场景：LLM 返回一个**宽表格**。`mdToANSI` 的表渲染逻辑（`ansi.ts:33-35`）：

```typescript
result = result.replace(/^\|(.+)\|$/gm, (_, row) => {
  const cells = row.split('|').map((s: string) => s.trim());
  return '  ' + cells.map((s: string) => s.padEnd(20)).join(' ').trim();
});
```

如果有 10 列，每列 `padEnd(20)`，一行 = `2 + 10*(20+1) = 212` 个字符，加上中间的 ANSI 粗体码，一行可能有 300+ 个可见字符 + 50+ 个不可见 ANSI 字节。Terminal 的 SwiftUI 文本视图尝试给这行做 intrinsic size 计算，布局算法无法在合理迭代内收敛。

---

## 四、为什么 8000 字符阈值不够

`ansi.ts:14` 已经有一个防御：

```typescript
if (text.length > 8000) return text.replace(/```[\s\S]*?```/g, '[code]').replace(/[*#`|>-]/g, '');
```

这解决了**单次 8000 字符以上的大块 ANSI 渲染**。但它防御不了：

| 场景 | 为什么漏掉 |
|------|-----------|
| 单次 ≤ 8000 但含 300 字符的宽行 | 行宽不是判断条件，总长度没超 |
| 25 次 4000 字符连续输出 | 每次都不超 8000，但累积 100K 字符 |
| 高频 burst：1 秒内 20 次 stderr.write | 没速率限制 |
| 多子 Agent 通知同时涌入 | 通知走 pendingNotifications → 下一轮一次性 flush |

**这个阈值是在治标——降低单次复杂度，没治本——累积量 + 行宽 + 速率。**

---

## 五、根本矛盾的形式化表述

```
Mycoder 输出策略的核心假设：
  "终端可以无限速率、无限体积地接收和显示文本"

macOS Terminal 的实际约束：
  "我是一个 SwiftUI 应用，每帧只能处理有限数量的文本变更"
```

这两个模型在低负载下相安无事。在 Mycoder 的高负载（25 轮迭代 × 多工具并行 × LLM 大块回复 × ANSI 渲染）下，约束被打破。打破后的行为不是优雅降级（如丢弃旧 scrollback），而是 **libmalloc 检测到腐败后主动崩溃**。

这不是 Mycoder 的 bug，也不是 Terminal 的 bug——是两种设计哲学在一个极端场景下发生了不可调和的冲突。修复的方向是**在 Mycoder 侧施加输出约束**，让它的输出模式适应 Terminal 的实际处理能力，而不是期望 Terminal 适应任意输出模式。

---

## 六、修复原则

从根本矛盾推导出的三条修复原则：

1. **不改造 Terminal，改造输出端**。Mycoder 是唯一可控的变量。
2. **约束输出，不约束能力**。Agent 仍然可以做 25 轮迭代和并行子 Agent——只是终端显示做节流和截断，完整内容保留在 sessionMessages 和日志中。
3. **分层防御**。行宽、速率、总量、ANSI 复杂度——四层各自独立，任何一层失效都不导致崩溃。
