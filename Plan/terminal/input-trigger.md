# 输入端触发机制：IME + 语音输入 + PTY 双向同步

> **⚠️ 更新（2026-08-03）：本文档的分析（IME 语音输入如何触发 Terminal 崩溃）仍然正确。**
> **但提出的修复方案（50ms 延迟 + 2000 字符限制）已被 `Mycoder.ts` 的 monkey-patch 折行替代。**
> **折行修复覆盖了输出端和输入端——因为输入回显也通过 PTY 进入 Terminal，而 `wrapOutput` 拦截了所有写入。**
> **50ms 延迟和长度限制不再需要。**
>
> ---
>
> （以下为原文）

---

## 零、这个发现颠覆了之前的假设

之前我们分析输出端（`root-cause.md`）时，得出一个单项结论：Mycoder 的大量 ANSI 输出撑爆了 Terminal 的文本渲染。

但这个结论有盲区。如果问题**只是**输出量太大，用户不说话、只敲回车执行命令时 Terminal 应该也会崩。但用户观察到的是：**手动打字没事，语音输入之后容易卡死。**

这意味着崩溃的触发条件不是一个（输出太大），而是**两个条件同时成立**（输出 + 输入 双向高负载），或者**输入端有独立的触发路径**。

---

## 一、输入端触发路径分析

### 1.1 语音输入 → IME → PTY 的完整链路

```
用户说话
  → 豆包输入法语音引擎处理
  → 识别完成，生成完整文本（可能 50-200 字符）
  → 输入法一次性 commit 到活跃文本域
  → Terminal.app 收到 commit 事件
  → Terminal 将文本写入 PTY master（往 slave 方向）
  → Node.js readline 从 stdin（PTY slave）读取到文本
  → Terminal 同时将文本 ECHO 到显示器（往屏幕方向）
```

注意这个链路有两个并行的终点：
- **PTY 方向**：写入 → Mycoder 进程读取
- **显示器方向**：终端回显 → SwiftUI 文本视图更新

这两个方向**同时**发生，且都在 Terminal 进程内部处理，共享同一套内存分配器。

### 1.2 语音输入区别于手动打字的三个特征

| 特征 | 手动打字 | 语音输入 |
|------|---------|---------|
| 文本注入速度 | 逐字符，30-100ms/字符 | 一次性 commit 50-200 字符 |
| IME 组成窗口 | 有（逐字显示候选） | 有（语音识别过程）+ 最后一次性消除 |
| 对 PTY 的冲击 | 分散的字符事件 | **一次性的文本洪峰** |
| Terminal 需要回显的量 | 每个字符单独回显 | 50-200 字符瞬间回显 |

语音输入 commit 的瞬间，Terminal 需要在 **一帧之内**：
1. 把 50-200 字符写入 PTY
2. 把这些字符全部回显到屏幕
3. 更新文本缓冲区
4. 触发 SwiftUI 重新渲染

这本质上就是我们在 `root-cause.md` 中分析的同一个问题——**大量文本在短时间内涌入 Terminal 的渲染管线**——只是这次的文本来源不是 Mycoder 的 `console.log`，而是用户输入的**回显**。

### 1.3 输入回显 vs 程序输出的本质区别

传统 Unix 上，输入回显由 PTY 的 `ECHO` 标志控制。当 `ECHO` 开启（默认），PTY master 自动把写入 slave 的每个字符原样回传给 master 的读端。这个回传和程序输出走**同一条管道**。

对 Terminal 来说，回显文本和程序输出文本本质上是同一种东西：都是从 PTY master 读到的字节流。Terminal **不区分** "这是用户按的回显" 还是 "这是程序打的结果"。两者都以相同的方式进入文本缓冲区，触发相同的渲染管线。

```
用户说了一句话 → IME commit 50 字
  → Terminal 写入 PTY slave（给 Mycoder 读）
  → PTY ECHO → Terminal 从 PTY master 读到这 50 字
  → Terminal 把它们当成"程序的输出"插入文本缓冲区
  → 触发 SwiftUI 渲染（同 root-cause.md 描述的管线）
  → 如果这 50 字恰好含长行 → 布局递归 → malloc 腐败
```

**这意味着输入端的大块文本注入，通过 PTY 的 ECHO 机制，等价于输出端的大块文本输出。它们走完全相同的渲染路径，触发完全相同的崩溃机制。**

---

## 二、双向并发：输入 + 输出同时在 PTY 中碰撞

### 2.1 致命时序

这是最危险的场景：

```
T0: 用户语音输入一句话（50 字），IME commit
T1: Terminal 开始写入 PTY + 回显
T2: 回显触发 Terminal 文本缓冲区更新 + SwiftUI 布局
T3: 与此同时，Mycoder 的 readline 收到完整的行
    → 回调触发 → agent.run() 开始
    → renderProgress 开始输出 "● Thinking..."
    → 又往 PTY 写入 ANSI 文本
T4: Terminal 的 PTY reader 读到 Mycoder 的输出
    → 又要更新文本缓冲区
T5: 两股文本变更在 Terminal 内部碰头：
    A. 用户输入的回显（还没渲染完）
    B. Mycoder 的输出（新的渲染请求）
```

在 T0 之前，Terminal 处于稳定状态。在 T1-T5 之间（可能只有 100-300ms），Terminal 的文本缓冲区被**两个来源**同时修改：
- 来自 PTY ECHO 的输入回显
- 来自 Mycoder 的程序输出

而 SwiftUI 的渲染管线**不是线程安全的**——所有 UI 更新必须在主线程。如果两股文本到达的时机导致 SwiftUI 的 `ViewGraph.updateOutputs` 被重入（上一次还没跑完，下一次又触发了），AttributeGraph 的状态机就可能进入不一致状态 → 布局计算异常 → 递归加深 → 同一条腐败路径。

### 2.2 PTY 的双工特性：输入和输出在同一个文件描述符上

PTY 是 full-duplex 的，但 Terminal 内部的文本缓冲区是单体的。这个不对称是关键：

```
         Terminal.app
        ┌──────────────────────────┐
        │   文本缓冲区 (单个体)      │
        │   ↙              ↖       │
        │ PTY输出         输入回显  │
        │ (Mycoder写)    (用户输入) │
        └──────────────────────────┘
                ↓           ↑
            PTY master (单个 fd)
                ↓           ↑
        ┌──────────────────────────┐
        │       PTY slave           │
        │   stdin ↑    stdout ↓    │
        │  (Mycoder读) (Mycoder写) │
        └──────────────────────────┘
```

所有文字——无论来自用户还是程序——最终都在同一个 SwiftUI 文本视图中渲染。Terminal 的内部架构可能**没有对输入回显和程序输出做写入时序的互斥**——因为在传统的逐字符打字场景下，输入和输出的速度差异足够大，不会碰撞。语音输入打破了这个假设。

---

## 三、readline + ANSI 提示符：输入法的视角被扭曲

### 3.1 Node readline 是怎么算光标位置的

Mycoder 的 prompt：
```typescript
const C = '\x1b[36m'; const B = '\x1b[1m'; const b = '\x1b[22m'; const c = '\x1b[39m';
const prompt = `${C}${B}mycoder${b}${c} ${B}>>>${b} `;
```

Node.js `readline` 需要知道 prompt 在屏幕上的**可见宽度**来决定光标位置。它通过 `readline.Interface` 的构造函数参数或内部估算来做这个计算。

如果 readline 把 ANSI 转义序列的字节数算进了光标位置（即 `\x1b[36m\x1b[1m` 被当成 8 个可见字符），光标位置就会**向右偏移** 8 格。

对输入法来说，组成窗口（IME composition window）的位置就是光标位置。如果光标位置偏移了，组成窗口出现在错误的位置，Terminal 的文本渲染层需要额外处理这个偏移。这可能触发边缘情况的布局 bug。

### 3.2 长语音输入 + ANSI prompt 的组合效应

```
用户语音输入 "帮我写一个React组件来实现用户登录功能"
  → 18 个中文字符，IME commit
  → Terminal 回显这 18 个字符
  → 但回显位置从"偏移的光标"开始
  → SwiftUI 文本视图的行宽计算：
      实际行宽 = ANSI prompt(不可见) + 18 个中文字符
              = 被高估了几个字符宽度
  → 如果行尾恰好接近 Terminal 窗口右边界
  → 布局引擎在"换行 vs 不换行"之间来回摇摆
  → 同一条布局递归路径
```

---

## 四、统一的崩溃模型：输入 + 输出走同一条渲染管线

### 之前（只考虑输出端）

```
高负载输出 → 108MB scrollback → 布局递归 → malloc corruption
```

### 现在（输入端也参与）

```
                      ┌── 语音输入一次性 commit → 回显大块文本 ──┐
                      │                                          │
                      ▼                                          ▼
              Terminal 文本缓冲区 (共同的攻击面)
                      │
                      ▼
              SwiftUI Text 渲染管线
                      │
                      ▼
              布局递归 → nano malloc corruption → SIGTRAP
                      ▲
                      │
高负载输出 → 108MB scrollback ──┘
```

**输入和输出共享同一个攻击面：Terminal 的 SwiftUI 文本渲染管线。** 语音输入只是从另一个方向往同一个渲染管线扔了一颗"文本炸弹"。

这解释了为什么：
- 手动打字不崩：逐字符输入给 Terminal 足够的时间消化每次渲染
- 语音输入崩：一次性 50-200 字符的回显等效于一次 `console.log(大块文本)`
- 语音输入 + Mycoder 输出同时发生最容易崩：两股文本洪峰叠加

---

## 五、输入端特有的修复手段

输出端的四层防御（`fix-plan.md`）对输入端也**间接有效**（输出节流减少了叠加概率）。但还有一些输入端特有的手段：

### 5.1 接收输入后加启动延迟

**改动文件**：`src/cli.ts`

```typescript
// 在 agent.run() 之前加一个微小的延迟
// 给 Terminal 时间完成输入回显的渲染，避免和输出叠加
const input = await ask(prompt);
if (input === undefined) { /* handle EOF */ }

// ★ 新增：输入端缓冲延迟
await new Promise(r => setTimeout(r, 50)); // 50ms，三帧的时间
// 让 Terminal 消化完回显再开始输出

const result = await engine.run(input.trim(), renderProgress);
```

50ms 是什么概念：
- 3 帧（在 60Hz 显示器上）
- 人完全无法感知（人在 100ms 以下感觉不到延迟）
- 足够 Terminal 把回显文本完全渲染到屏幕

### 5.2 输入长度软限制

```typescript
const MAX_INPUT_LENGTH = 2000;

if (input.trim().length > MAX_INPUT_LENGTH) {
  console.log(`Input too long (${input.trim().length} chars). Max: ${MAX_INPUT_LENGTH}.`);
  continue; // 回到 prompt，不执行
}
```

语音输入偶尔会产生异常长的文本（识别错误导致乱码），加一个软限制保护 Terminal 不被超长输入的回显撑爆。

### 5.3 readline prompt 的 ANSI 安全

Node readline 的 prompt 参数如果含 ANSI 码，可能影响光标位置计算。可以用更明确的方式告诉 readline 真实 prompt 长度：

```typescript
// 计算不含 ANSI 码的 prompt 可见宽度
const RAW_PROMPT = 'mycoder >>> ';
const PROMPT = `${C}${B}mycoder${b}${c} ${B}>>>${b} `;

// 如果 Node 版本支持，通过 terminal 参数告知
// （Node v22+ 的 readline 对 ANSI prompt 的支持有所改善）
```

不过这个依赖于 Node 版本，当前不做强制修改，标记为已知问题。

### 5.4 为什么不在输入端做节流

输入不能节流——用户按了回车/语音 commit 后，延迟执行会让 Mycoder 感觉"卡顿"。所以输入端只做两件事：
1. **50ms 启动延迟**：给 Terminal 消化回显的时间
2. **长度软限制**：防止异常长输入

---

## 六、更新后的修复原则

对比 `root-cause.md` 的原始三条原则，追加以输入视角：

1. **不改造 Terminal** — 不变
2. **约束输出，不约束能力** — 不变
3. **分层防御** — 扩展：从四层输出控制变为**四层输出控制 + 两层输入防护**
4. **输入端与输出端共享同一个攻击面** — 新增认知：减少任何一端的大块文本注入都能降低崩溃概率

---

## 七、与输出端修复的协同效应

| 输出端修复 (`fix-plan.md`) | 对输入端的间接收益 |
|---------------------------|------------------|
| 第 1 层：行宽限制 | 输入回显的长行也被截断 |
| 第 2 层：单次输出上限 4000 字符 | 减少了 Agent 开始处理后瞬间刷屏的量 |
| 第 3 层：输出节流 16ms | 给输入回显渲染留出了时间窗口 |
| 第 4 层：突发 ANSI 降级 | 纯文本比 ANSI 渲染快得多，给输入回显留出更多 CPU |

**输入端新增的两层**（50ms 延迟 + 长度限制）和输出端四层各自独立生效，总共六层。

---

## 八、更新日志

| 日期 | 事件 |
|------|------|
| 2026-08-03 | 初始创建：基于用户语音输入触发 Terminal 卡顿的观察 |
