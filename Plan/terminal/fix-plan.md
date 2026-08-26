# ~~实施方案：四层输出控制~~ ❌ 已废弃

> **⚠️ 本文案已被 [边界折行方案](./corrected-fix.md) 替代。**
> **废弃原因**：依赖魔法参数（行宽 200、输出 4000、节流 16ms、突发 10KB/s），治标不治本。
> **保留此文件**：作为方案演进的历史记录。
>
> ---
>
> （以下为原文）
> **预计行数**：+80 行

---

## 设计原则

从根本矛盾推导：

1. **不改造 Terminal，只改造 Mycoder 输出端**
2. **约束输出不约束能力**——Agent 仍然 25 轮迭代、并行子 Agent，只是终端显示做节流和截断
3. **完整内容保存到 sessionMessages**，不丢数据，只是不全部推到终端
4. **分层防御**——任何一层都可以独立防止崩溃

---

## 第 1 层：行宽硬限制

### 改动文件：`src/ansi.ts`

### 问题

`mdToANSI` 的表渲染 `padEnd(20)` 对宽表不做限制，LLM 返回 10 列表格 → 每行 220+ 字符 → Terminal 布局算法发散。

### 修复

新增行宽限制函数，所有 `mdToANSI` 输出行不超过最大值：

```typescript
const TERMINAL_WIDTH = process.stdout.columns || 120;
const MAX_LINE_LENGTH = Math.min(TERMINAL_WIDTH, 200);

/**
 * 硬截断超长行。
 * 注意：需要感知 ANSI 转义序列——不计入可见字符宽度。
 */
function hardWrapLine(line: string, maxLen: number): string {
  let visible = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      // 跳过整个转义序列直到 'm'
      while (i < line.length && line[i] !== 'm') i++;
      continue;
    }
    visible++;
    if (visible > maxLen) {
      return line.slice(0, i) + '…';
    }
  }
  return line;
}
```

在 `mdToANSI` 的返回前对每行应用：

```typescript
// mdToANSI return 前新增
result = result.split('\n').map(line => hardWrapLine(line, MAX_LINE_LENGTH)).join('\n');
```

### 为什么放在 `mdToANSI` 而不是 cli.ts

因为 `renderProgress` 也调用 `mdToANSI`（thought 事件的 text 渲染），所以行宽限制应该是 `mdToANSI` 的内在属性，不是 cli.ts 的职责。

---

## 第 2 层：单次回复输出上限

### 改动文件：`src/cli.ts`

### 问题

```typescript
console.log(`\n${mdToANSI(result.text)}\n[${result.ms}ms]\n`);
```

`result.text` 可能 5000+ 字符，全量 ANSI 渲染后推到 Terminal。

### 修复

渲染前截断，超出部分给灰色提示：

```typescript
const MAX_RENDER_LENGTH = 4000;

let displayText = result.text;
let truncationNote = '';

if (displayText.length > MAX_RENDER_LENGTH) {
  truncationNote = `\n\x1b[90m... (${displayText.length - MAX_RENDER_LENGTH} more chars — full content in session)\x1b[39m`;
  displayText = displayText.slice(0, MAX_RENDER_LENGTH);
  // 确保截断不在单词中间（找最近的换行或空格）
  const lastBreak = Math.max(
    displayText.lastIndexOf('\n'),
    displayText.lastIndexOf('. '),
    displayText.lastIndexOf('。'),
  );
  if (lastBreak > MAX_RENDER_LENGTH * 0.7) {
    displayText = displayText.slice(0, lastBreak + 1);
  }
}

console.log(`\n${mdToANSI(displayText)}${truncationNote}\n[${result.ms}ms]\n`);
```

### 为什么是 4000 而不是 6000

4000 字符 ≈ 80 行 × 50 字符。考虑到 ANSI 码的额外开销，4000 字符的 markdown 渲染后大约 5000-6000 字节写入 PTY。这是一个既能让 LLM 回复完整传达，又不会撑爆 Terminal 的量。

---

## 第 3 层：输出速率节流

### 新增文件：`src/output-throttle.ts`

### 问题

```typescript
// renderProgress 里每次工具调用都立即写 stderr
process.stderr.write(`  ● ${B}Thinking${b} (${event.label})`);
// 25 轮迭代 × 平均 3 个工具 = 75 次独立 write()
```

每次 `write()` 触发 Terminal 的 PTY reader 唤醒 → 解析 → 渲染。75 次/秒的高频小写入 → Terminal 的渲染管线来不及排空。

### 修复

在 stdout/stderr 和 PTY 之间插入一个微小的输出缓冲：

```typescript
/**
 * 输出节流器：累积短时间内的 write 调用，合并为一次实际 PTY write。
 * flush 间隔 = 16ms（60fps），与显示器刷新率对齐。
 */
export class OutputThrottle {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private stream: NodeJS.WriteStream,
    private flushIntervalMs = 16,
  ) {}

  write(text: string): void {
    this.buffer += text;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  /** 立即 flush（进程退出前调用） */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  private flush(): void {
    if (this.buffer.length > 0) {
      this.stream.write(this.buffer);
      this.buffer = '';
    }
    this.timer = null;
  }
}
```

### 改动文件：`src/cli.ts`

```typescript
import { OutputThrottle } from './output-throttle.js';

// REPL 开始时创建两个节流器
const out = new OutputThrottle(process.stdout);
const err = new OutputThrottle(process.stderr);

// 所有 process.stderr.write → err.write
// 所有 console.log → out.write(... + '\n')
// 进程退出前：out.flushNow(); err.flushNow();
```

### 注意事项

- `thinking_start` 事件不写 `\n`，用 `\r` 覆盖同一行。这在节流后仍然有效——`\r` 在 buffer 中正确处理
- 16ms 是 60fps 的帧间隔。即使所有输出都在同一帧内，Terminal 也只渲染一次
- 对用户体验的影响：几乎不可感知。人类无法区分 0ms 延迟和 16ms 延迟

---

## 第 4 层：突发 ANSI 降级

### 改动文件：`src/ansi.ts`

### 问题

当输出速率超过 Terminal 的处理能力后，ANSI 解析是最大的 CPU 消耗者。此时应该自动降级为纯文本。

### 修复

```typescript
// === 输出速率追踪 ===
let burstByteCount = 0;
let burstWindowStart = Date.now();
const BURST_THRESHOLD = 10_000; // 10KB/s

/** 每次 mdToANSI 调用前调用此函数 */
export function trackOutput(length: number): void {
  const now = Date.now();
  if (now - burstWindowStart > 1000) {
    burstByteCount = 0;
    burstWindowStart = now;
  }
  burstByteCount += length;
}

/** 当前是否处于输出突发状态 */
export function inBurstMode(): boolean {
  const now = Date.now();
  if (now - burstWindowStart > 1000) {
    burstByteCount = 0;
    burstWindowStart = now;
  }
  return burstByteCount > BURST_THRESHOLD;
}
```

在 `mdToANSI` 开头加入降级判断：

```typescript
export function mdToANSI(text: string): string {
  if (!process.stdout.isTTY) return text.replace(...);

  // 突发模式：跳过 ANSI 渲染，减轻 Terminal 压力
  if (inBurstMode() && text.length > 500) {
    return text
      .replace(/```[\s\S]*?```/g, (m) => `\n[code]\n${m.slice(3, -3).trim()}\n[/code]\n`)
      .replace(/[*#`|>-]/g, '');
  }

  if (text.length > 8000) return text.replace(...);

  // 追踪本次输出
  trackOutput(text.length);

  // ... 原有 ANSI 渲染逻辑
}
```

### 降级策略的渐变

```
正常：text ≤ 8000 + 速率正常 → 完整 ANSI 渲染
突发：速率 > 10KB/s + text > 500 → 纯文本（保留代码块结构）
超长：text > 8000 → 纯文本（代码块标记化）
非TTY：管道/重定向 → 纯文本
```

---

## 五、改动清单

| 文件 | 改动 | 预计行数 |
|------|------|---------|
| `src/ansi.ts` | hardWrapLine() + inBurstMode() + trackOutput() | +35 |
| `src/cli.ts` | 单次回复上限 + 全量切换为 OutputThrottle + 50ms 启动延迟 + 输入长度限制 | +22/-5 |
| `src/output-throttle.ts` | **新增文件** | +30 |

**总计**：+87/-5 = 净增 82 行。

---

## 六、验证标准

### 崩溃复现测试（修之前先跑，确认能复现）

```bash
# 模拟 Mycoder 的高频 ANSI 输出
yes "$(printf '\x1b[1mBold\x1b[22m \x1b[90mGray\x1b[39m %.0s' {1..20})" | head -5000
# 在另一个 Terminal 中观察：内存是否飙升？是否崩？
```

### 修复后验证

| # | 场景 | 期望 |
|---|------|------|
| 1 | LLM 返回 8000 字符含 10 列表格 | 终端输出被截断在 4000 字符，行宽 ≤ 200 |
| 2 | Agent 连续 20 轮对话 | Terminal MALLOC 稳定在 30MB 以内 |
| 3 | 3 个子 Agent 同时完成 | 通知被合并（Phase 53）+ 输出节流 → 不会瞬间刷屏 |
| 4 | 1 秒内 20 次工具调用 | 突发降级触发 → ANSI 被跳过 → Terminal 解析压力骤降 |
| 5 | 正常对话 | 感知不到节流/截断的存在 |

---

## 七、输入端防护（`input-trigger.md` 的落地方案）

### 说明

`input-trigger.md` 揭示了输入端也会触发 Terminal 崩溃——语音输入一次性 commit 50-200 字符，通过 PTY ECHO 机制，等价于一次大块文本输出，走同一条 SwiftUI 渲染管线。如果此时 Mycoder 也开始输出（agent.run 启动），两股文本洪峰在 Terminal 的文本缓冲区中碰撞。

### 5.1 接收输入后加启动延迟

**改动文件**：`src/cli.ts`

```typescript
const input = await ask(prompt);
if (input === undefined) { /* handle EOF */ }
if (!input.trim()) continue;
if (input.trim() === '/exit' || input.trim() === '/quit') break;
if (input.trim() === '/help') { /* ... */ }

// ★ 给 Terminal 50ms（~3 帧）消化输入回显的渲染
// 避免回显和输出碰头触发双向并发崩溃
// 50ms 对人类完全不可感知（知觉阈值 ~100ms）
await new Promise(r => setTimeout(r, 50));

const result = await engine.run(input.trim(), renderProgress);
```

### 5.2 输入长度软限制

```typescript
const MAX_INPUT_LENGTH = 2000;

if (input.trim().length > MAX_INPUT_LENGTH) {
  console.log(
    `Input too long (${input.trim().length} chars > ${MAX_INPUT_LENGTH} max). ` +
    `Please split into shorter messages.`
  );
  continue;
}
```

语音输入偶尔会产生异常长的乱码文本（识别失败），2000 字符的上限拦截这些异常输入，同时不影响正常使用（2000 字符 = ~1000 个中文字，远超任何合理的手动/语音输入）。

### 5.3 为什么不在输入端做节流

输入不能节流——用户 commit 后延迟执行会让 Mycoder 感觉"卡了"。所以输入端只做：
- **50ms 启动延迟**：给 Terminal 消化回显
- **长度软限制**：拦截异常长输入

---

## 八、不做的事

| 事项 | 决定 | 理由 |
|------|------|------|
| 限制 Agent 迭代次数 | 不做 | 25 轮是合理上限，问题在每轮的输出量不在轮数 |
| 把 LLM 回复写文件 | 不做 | 改变使用体验，等用户反馈再决策 |
| 在 Terminal 侧设 scrollback 限制 | 不做 | 应该用户自己控制，不应该是 Mycoder 的责任 |
| 替换 iTerm2/kitty | 不是代码方案 | 这些终端可能更稳定（非 SwiftUI），但 Mycoder 应该在任何终端都能用 |
