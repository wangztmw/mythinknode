# Phase 50 计划：输出层分离 — 最简方案

> **创建时间**：2026-08-02
> **状态**：计划中
> **核心文件**：`src/agent.ts`、`src/cli.ts`（只改 2 个文件，新增 0 个文件）
> **重构类型**：消除引擎对 stdout/stderr 的直接依赖
> **风险等级**：中 — 涉及 Agent 循环的渲染路径重连

---

## 一、核心思路

**agent.ts 不再 import `mdToANSI`、不再 import ANSI 常量、不再写 stdout/stderr。** 所有输出通过一个简单的回调传给 CLI 层，CLI 层统一渲染。

```
当前（脏）:
  agent.ts: mdToANSI(thoughts) + process.stderr.write(thinking) + console.error(tool_display) + displayMergedTools()
  引擎直接控制终端

目标（干净）:
  agent.ts: onProgress({ type: 'thinking', ... })   ← 只发事件
  cli.ts:   收到事件 → 唯一渲染入口 → mdToANSI 只在这里调用
```

**改动范围**：只改 2 个文件，0 个新文件，不计入 tools-v2。

---

## 二、ProgressEvent 类型（写在 agent.ts 顶部）

```ts
/**
 * Agent 引擎进度事件。
 * 引擎只产生这些事件，不负责渲染。
 * CLI 层接收事件并决定如何显示。
 */
export type ProgressEvent =
  | {
      type: 'thinking_start';
      label: string;
    }
  | {
      type: 'thinking_end';
      label: string;
      elapsedMs: number;
      toolCount: number;
    }
  | {
      type: 'tool_display';
      calls: ToolCall[];
    }
  | {
      type: 'thought';
      text: string; // 原始 Markdown 思考文字，不含 ANSI
    }
  | {
      type: 'error';
      message: string;
    };
```

### 2.1 为什么分 `thinking_start` 和 `thinking_end`

当前 `callLLM()` 里的思考显示是两步：
```ts
process.stderr.write(`  ● Thinking (${label})`);   // 开始 — 不换行
// ... API 调用 ...
process.stderr.write(`\r  ● Thinking (${elapsed}s) — ${label} → ${n} tools\n`);  // 结束 — 覆盖并换行
```

`\r` 覆盖是 CLI 特有的渲染技巧（回到行首重新写）。**引擎不应该知道 `\r` 是什么。** 拆成两个事件：`thinking_start` 告诉 CLI"开始显示了"，`thinking_end` 告诉 CLI"可以覆盖并换行了"。

CLI 渲染代码：
```ts
case 'thinking_start':
  process.stderr.write(`  ● ${B}Thinking${b} (${event.label})`);
  break;
case 'thinking_end':
  process.stderr.write(`\r  ● ${B}Thinking${b} (${(event.elapsedMs/1000).toFixed(1)}s) — ${event.label} → ${event.toolCount} tools\n`);
  break;
```

### 2.2 为什么保留 `tool_display` 而不是更细粒度

当前 `displayMergedTools()` 做了两件事：(1) 合并连续同工具调用 (2) 渲染。合并逻辑适合留在 agent.ts（它需要理解工具语义），渲染逻辑移到 cli.ts。`tool_display` 事件带的是合并后的数据。

### 2.3 `thought` 事件

当前引擎在拿到 tool_use 响应后，把思考文字用 `mdToANSI(thoughts)` 渲染后直接 `console.error`。改为发原始 Markdown 给 CLI。

---

## 三、agent.ts 改动明细

### 3.1 构造函数变化

```ts
// 删除这些 import:
import { mdToANSI, B, b } from './ansi.js';  // ← 全删

// 新增:
import type { ProgressEvent } from './agent.js';  // 或直接定义在文件内
```

### 3.2 runAgent() 签名变化

```ts
// 当前:
async run(userInput: string): Promise<string>

// 目标:
async run(
  userInput: string,
  onProgress?: (event: ProgressEvent) => void
): Promise<{ text: string; ms: number }>
```

返回值从拼接好 ANSI 的字符串 → 包含原始 Markdown 文本和耗时的对象。**`text` 是纯 Markdown，零 ANSI 码。**

### 3.3 callLLM() 改造

```ts
// 当前:
process.stderr.write(`  ● ${B}Thinking${b} (${thinkLabel})`);
// ... LLM 调用 ...
process.stderr.write(`\r  ● ${B}Thinking${b} (${elapsed}s) — ${thinkLabel}${hint}\n`);

// 目标:
onProgress?.({ type: 'thinking_start', label: thinkLabel });
// ... LLM 调用 ...
onProgress?.({ type: 'thinking_end', label: thinkLabel, elapsedMs: Date.now() - thinkStart, toolCount });
```

### 3.4 runAgent() 内部循环改造

```ts
// 当前（行 227-228）: agent.ts 直接渲染思考文字
const thoughts = ...;
if (thoughts) console.error(`  ${mdToANSI(thoughts.slice(0, 300))}`);

// 目标:
const thoughts = ...;
if (thoughts) onProgress?.({ type: 'thought', text: thoughts });

// 当前（行 252-274）: displayMergedTools(calls)
// 目标:
onProgress?.({ type: 'tool_display', calls });
```

### 3.5 displayMergedTools() 方法

**保留合并逻辑，删除渲染逻辑。** 改为返回合并后的数据而不是直接写 console：

```ts
// 当前: private displayMergedTools(calls) { ... console.error(...) }
// 目标: private mergeTools(calls): MergedCall[] { ... return merged }
//       （只做数据合并，不渲染）
// 然后: onProgress?.({ type: 'tool_display', calls: mergeToolCalls(calls) });
```

### 3.6 runSubAgent() 改造

子 Agent 的渲染路径也改——把 `process.stderr.write` 和 `console.error` 去掉，换成 `onProgress` 回调。但子 Agent 通常是"静默执行"的——当前代码里 `callLLM` 已经有 `_isSubAgent` 检查来跳过显示。这个逻辑保持，但在 runSubAgent 里不传 onProgress 即可（子 Agent 自己产生数据，但不需要往主 CLI 打——原来的设计就是如此）。

**关键风险点**：子 Agent 内部也调用 `callLLM`。当前通过全局 `_isSubAgent` 标志跳过思考显示。重构后，`callLLM` 不再有 `_isSubAgent` 检查——思考事件是否发送完全由调用方决定：

```ts
// runAgent (主 Agent):
callLLM(messages, label, onProgress)  // 传回调 → 会发 thinking_start/end

// runSubAgent (子 Agent):
callLLM(messages)  // 不传回调 → 静默
```

### 3.7 callLLM 签名变化

```ts
// 当前:
private async callLLM(messages: ChatMessage[], label?: string): Promise<...>

// 目标:
private async callLLM(
  messages: ChatMessage[],
  label?: string,
  onProgress?: (event: ProgressEvent) => void
): Promise<...>
```

### 3.8 全局 `_isSubAgent` 消除

这是之前 Phase 47 就该做的事，但因为 callLLM 里有 `_isSubAgent` 检查所以留了尾巴。现在 callLLM 不再需要这个标志——**删掉 `_isSubAgent` 全局变量**。

---

## 四、cli.ts 改动明细

### 4.1 新增渲染函数

```ts
function renderProgress(event: ProgressEvent): void {
  switch (event.type) {
    case 'thinking_start':
      process.stderr.write(`  ● ${B}Thinking${b} (${event.label})`);
      break;
    case 'thinking_end':
      const s = (event.elapsedMs / 1000).toFixed(1);
      const hint = event.toolCount > 0 ? ` → ${event.toolCount} tool${event.toolCount > 1 ? 's' : ''}` : '';
      process.stderr.write(`\r  ● ${B}Thinking${b} (${s}s) — ${event.label}${hint}\n`);
      break;
    case 'thought':
      process.stderr.write(`  ${mdToANSI(event.text.slice(0, 300))}\n`);
      break;
    case 'tool_display':
      renderMergedTools(event.calls);
      break;
    case 'error':
      console.error(`  ✗ ${event.message}`);
      break;
  }
}
```

### 4.2 调用 AgentEngine

```ts
const result = await engine.run(input.trim(), renderProgress);
// result.text 是纯 Markdown，这里统一渲染
console.log(`\n${mdToANSI(result.text)}\n[${result.ms}ms]\n`);
```

**全局只此一处调用 `mdToANSI()`。**

### 4.3 renderMergedTools()

把原来 agent.ts 的 `displayMergedTools()` 的渲染部分搬过来：

```ts
function renderMergedTools(calls: ToolCall[]): void {
  // 合并连续同工具调用（数据逻辑）
  const merged = mergeConsecutiveTools(calls);
  // 渲染
  for (const m of merged) {
    const label = m.count > 1 ? `${m.name} ×${m.count}` : m.name;
    const params = m.inputs.join(', ');
    const info = m.count > 1 ? `(${m.lines} lines total)` : `→ ${m.sample}`;
    console.error(`  ● ${B}${label}${b}: ${params}  ${info}`);
  }
}
```

`mergeConsecutiveTools` 和 `briefResult` 这两个纯数据函数可以从 agent.ts 移到 cli.ts，或在 agent.ts 里保留但只导出工具调用数据。

---

## 五、Mycoder.ts 改动明细

**无变化。** `Mycoder.ts` 不直接调用 `mdToANSI`，不直接写 stdout。所有渲染已经通过 `startCLI → runAgent → renderProgress` 路径收束。

---

## 六、ansi.ts 状态

**保留不删。** 只导出 `mdToANSI` 和 ANSI 常量（B/b/D/d/G/c），cli.ts 继续 import。agent.ts 不再 import。

---

## 七、被消除的依赖关系

### agent.ts 不再 import

| 当前 import | 为何不再需要 |
|------------|------------|
| `mdToANSI` from `./ansi.js` | 思考文字走 `thought` 事件，正文走 `result.text` |
| `B, b` from `./ansi.js` | callLLM 的 thinking 显示走 `thinking_start/end` 事件 |

### agent.ts 不再写的流

| 当前写法 | 改为 |
|---------|------|
| `process.stderr.write('  ● Thinking...')` | `onProgress({ type: 'thinking_start' })` |
| `process.stderr.write('\r  ● Thinking...\n')` | `onProgress({ type: 'thinking_end' })` |
| `console.error('  ● Bash: ...')` | `onProgress({ type: 'tool_display' })` |
| `console.error('  ${mdToANSI(thoughts)}')` | `onProgress({ type: 'thought' })` |
| `console.error('  ✗ Sub-agent...')` | `onProgress({ type: 'error' })` |

### 全局变量消除

| 变量 | 状态 |
|------|------|
| `_isSubAgent` | **删除** — callLLM 不再有 `_isSubAgent` 检查 |

---

## 八、完整影响范围

| 文件 | 改动行数 | 说明 |
|------|---------|------|
| `src/agent.ts` | ~30 行 | 加类型、改签名、删渲染逻辑、删 `_isSubAgent` |
| `src/cli.ts` | ~60 行 | 加 `renderProgress` + `renderMergedTools` 函数 |
| 总计 | ~90 行 | 2 个文件 |

**不影响**：tools-v2/、task.ts、config.ts、llm/、Mycoder.ts

---

## 九、执行步骤

### Step 1：定义 ProgressEvent 类型

在 `agent.ts` 顶部新增 ProgressEvent 类型和 ToolCall 接口。~20 行。

### Step 2：改 callLLM()

- 加 `onProgress?` 参数
- `thinking_start/end` 替代 `process.stderr.write`
- 删除对 `_isSubAgent` 的检查
- 子 Agent 不传 onProgress → 静默

### Step 3：改 runAgent()

- 签名：`(userInput, onProgress?) → Promise<{ text, ms }>`
- 思考文字走 `thought` 事件
- 工具调用走 `tool_display` 事件
- displayMergedTools() 改为纯数据函数 mergeToolCalls()

### Step 4：改 runSubAgent()

- 子 Agent 内部不传 onProgress 给 callLLM（保持静默）
- 删除 `_isSubAgent` 全局变量

### Step 5：改 cli.ts

- 新建 `renderProgress(event)` 和 `renderMergedTools(calls)` 函数
- 搬 `briefResult` 到 cli.ts（或 agent.ts export）
- 引擎调用改为 `engine.run(input, renderProgress)`

### Step 6：清理

- agent.ts 删除 `import { mdToANSI, B, b }`
- agent.ts 删除 `_isSubAgent` 全局变量和 `_thinkStart`/`_thinkLabel` 全局变量

### Step 7：编译 + 冒烟

```bash
npx tsc --noEmit
npm run build
MYCODER_API_KEY=sk-test printf '/help\n/exit\n' | node dist/Mycoder.js
```

### Step 8：视觉回归

- 确认 Thinking 显示和原来一样（开始 → 覆盖 → 结束）
- 确认工具链彩色显示和原来一样
- 确认思考文字显示和原来一样
- 确认子 Agent 仍然不刷屏

---

## 十、不做的事

| 不做 | 原因 |
|------|------|
| 创建独立文件 | 回调方案足够简单，不需要 extra files |
| OutputAdapter 接口 | 过度设计——一个回调函数就是全部接口 |
| JSON 适配器 | 放后续 Phase |
| Plain 适配器 | `process.stdout.isTTY` 检查已经够用 |
| 改 tools-v2 | 无关 |

---

## 十一、潜在风险与预防

| 风险 | 预防 |
|------|------|
| 回调抛异常中断 Agent 循环 | cli.ts 的 `renderProgress` 内部 try/catch 兜底，不抛出 |
| thinking_start 后 thinking_end 没发（LLM 调用异常） | callLLM 的 catch 里补发 `thinking_end` 或发 `error` |
| mcderToolCalls 合并逻辑搬家后行为不一致 | 搬逻辑不搬渲染——合并部分的代码原样复制 |
| `briefResult` 被 agent.ts 内部还在用 | 先搜一下所有引用再搬 |

---

## 十二、实施清单

- [ ] Step 1: 定义 `ProgressEvent` 类型
- [ ] Step 2: 改 `callLLM()` — 去掉 stdout 写入，去掉 `_isSubAgent` 检查
- [ ] Step 3: 改 `runAgent()` — 返回值 + 回调路径
- [ ] Step 4: 改 `runSubAgent()` — 子 Agent 不传 onProgress
- [ ] Step 5: 改 `cli.ts` — 新建 `renderProgress` + `renderMergedTools`
- [ ] Step 6: 清理 — 删 agent.ts 的 `mdToANSI`/`B`/`b` import，删 `_isSubAgent`
- [ ] Step 7: `npx tsc --noEmit` 零错误
- [ ] Step 8: 冒烟测试（/help + /exit + EOF） + 视觉回归
