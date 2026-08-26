# 输入端冻结：PTY 缓冲区阻塞与架构级修复

> **隶属**：Plan/terminal/
> **创建时间**：2026-08-03
> **状态**：✅ Phase 55 已实施 —— 事件驱动 stdin + 输入队列
> **触发事件**：用户在 Mycoder agent 运行期间使用豆包输入法语音输入，Terminal 无法继续输入（但可以滚动查看内容）
> **根因**：Mycoder 的同步 REPL 模型在 agent 处理期间不读 stdin，PTY 输入缓冲区（8192 字节）被语音输入瞬间填满，Terminal 写入端阻塞

---

## 一、现象

| 症状 | 状态 |
|------|------|
| 输入新文字 | ❌ 无法输入 |
| 鼠标滚轮滚动查看历史 | ✅ 正常 |
| Terminal 其他功能 | ✅ 正常 |
| 触发条件 | 语音输入大段文字时，尤其 Mycoder 正在输出时 |

**本质**：不是 Terminal 崩了，不是 Mycoder 进程崩了，是 PTY 的输入方向被阻塞了。输出方向正常（所以滚动查看内容可以）。输入方向因为缓冲区满了，Terminal 的 `write()` 阻塞，无法再接受新的键盘/IME 输入。

---

## 二、根因分析

### 2.1 PTY 缓冲区机制

```
用户输入（键盘/IME）
  → Terminal.app 接收
  → Terminal 写入 PTY master（输入方向）
  → OS 内核缓冲（8192 字节固定大小）
  → Mycoder 的 stdin（PTY slave）读取
```

PTY 是双向的：master→slave 是输入方向，slave→master 是输出方向。两个方向的缓冲区独立。输出方向通常很大或无限（scrollback），输入方向是固定的内核缓冲区（macOS 默认 8192 字节）。

### 2.2 填满过程

```
T0: 用户在 Mycoder prompt 输入后回车
T1: Mycoder 进入 agent.run()（开始处理，停止读 stdin）
T2: agent.run() 运行 30-60 秒（LLM 调用 + 工具执行）
T3: 用户语音输入一段话（200+ 字 = 600+ 字节）
T4: 输入法 commit → Terminal 写入 PTY → 进入 8192 字节的内核缓冲区
T5: 用户可能继续打字 → 缓冲区接近满
T6: 缓冲区满 → Terminal.write() 阻塞 → UI 卡住
T7: 用户无法输入新文字，但可以滚动（输出方向正常）
```

### 2.3 为什么其他 CLI 工具不这样

| 工具 | 输入模式 | 处理期间对 stdin 的态度 |
|------|---------|----------------------|
| `npm install` | 一次性命令 | 不期望用户在处理期间输入 |
| `vim` | 持续读取 | 始终在读 stdin（事件循环） |
| `ssh` | 持续读取 | 始终在读 stdin（转发到远端） |
| **Mycoder** | REPL | **agent.run() 期间 stdin 被遗忘** |

Mycoder 的 REPL 模型假设输入→处理→输出是原子的。处理期间不读输入。但如果处理时间长达 30-60 秒，而用户又可能想在此期间输入（语音、修正），这个假设就破了。

### 2.4 为什么是语音输入特别容易触发

手动打字：逐字符，30-100ms/字符。输入 100 字需要 3-10 秒。缓冲区有足够时间排空（如果 agent 偶尔读一下 stdin）。

语音输入：识别完成后一次性 commit 50-200 字符。在**一瞬间**向 PTY 输入 600+ 字节。Mycoder 在同一瞬间没有读 stdin → 缓冲区瞬时填入 600 字节。如果 agent 处理了 30 秒，期间用户又语音输入了 3-4 段话 + 手动打了一些字 → 轻松超过 8192 字节。

---

## 三、临时修复（已实施）

### 代码

```typescript
// cli.ts — agent.run() 前
const drainTimer = setInterval(() => {
  while (process.stdin.read() !== null) { /* drain */ }
}, 100);
// ... agent.run() ...
clearInterval(drainTimer);
```

### 机制

每 100ms 清空一次 stdin 的内核缓冲区。100ms × 8192 字节 = 最大清空速率 80KB/s，远超任何人类输入速率（包括语音输入）。缓冲区永远不会满，Terminal 永远不会阻塞。

### 为什么这仍然是治标

1. **丢失用户输入**：处理期间用户输入的内容被丢弃。用户需要等 agent 完成后重新输入。
2. **没有反馈**：用户不知道自己的输入被丢弃了，也不知道 agent 什么时候完成。
3. **依赖轮询**：100ms 是硬编码的。虽然合理，但它是一个"猜的"值。
4. **没有解决根本矛盾**：根本问题是 Mycoder 的同步 REPL 模型与长时间运行的 agent 处理之间的冲突。

---

## 四、治本方案：异步输入架构

### 4.1 根本矛盾

Mycoder 同时需要两种模式：
- **REPL 模式**：一问一答，顺序执行（readline 模型）
- **Agent Monitor 模式**：长时间运行，用户需要随时介入（事件驱动模型）

当前架构是纯 REPL。语音输入暴露了这个矛盾——用户在 agent 运行期间想"说话"，但架构不支持并行输入。

### 4.2 方案：事件驱动的 stdin + 输入队列

**核心思路**：不再使用 `readline.question()` 的阻塞模式。改用 `process.stdin` 的流模式，始终读 stdin。输入按行分割，agent 空闲时立即处理，agent 忙碌时进入队列。

```typescript
// 替代当前的 readline + while(true) 循环

const pendingInputs: string[] = [];  // agent 忙碌时暂存
let agentBusy = false;

process.stdin.setEncoding('utf8');
process.stdin.resume();

let lineBuffer = '';

process.stdin.on('data', (chunk: string) => {
  lineBuffer += chunk;

  // 处理完整的行
  while (lineBuffer.includes('\n')) {
    const idx = lineBuffer.indexOf('\n');
    const line = lineBuffer.slice(0, idx).trim();
    lineBuffer = lineBuffer.slice(idx + 1);

    if (!line) continue;
    if (line === '/exit' || line === '/quit') { /* 退出 */ }
    if (line === '/help') { /* 帮助 */ }

    if (agentBusy) {
      pendingInputs.push(line);
      process.stderr.write(`  [Queued: ${line.slice(0, 60)}...]\n`);
    } else {
      processInput(line);
    }
  }
});

async function processInput(line: string) {
  agentBusy = true;
  console.log('');
  const result = await engine.run(line, renderProgress);
  console.log(`\n${mdToANSI(result.text)}\n[${result.ms}ms]\n`);
  agentBusy = false;
  engine.flushNotifications();

  // 处理排队中的下一条输入
  if (pendingInputs.length > 0) {
    const next = pendingInputs.shift()!;
    process.stderr.write(`  [Processing queued: ${next.slice(0, 60)}...]\n`);
    await processInput(next);
  } else {
    process.stderr.write(`${C}${B}mycoder${b}${c} ${B}>>>${b} `);
  }
}
```

### 4.3 这个方案为什么是治本的

| 维度 | 旧方案（readline 同步） | 新方案（事件驱动） |
|------|----------------------|-------------------|
| stdin 何时读 | 只在 `ask()` 调用时 | **始终在读** |
| agent 处理期间输入 | PTY 缓冲区填满 → 阻塞 | 进入队列，不阻塞 |
| 输入是否丢失 | 临时方案丢弃 | **保留在队列中** |
| 用户反馈 | 无 | 显示 `[Queued: ...]` |
| 复杂输入（语音/IME） | 大块 commit 冲击缓冲区 | 流式读取，安全 |
| 硬编码参数 | 100ms 轮询间隔 | **无硬编码参数** |
| 代码行数 | 当前 101 行 + 3 行补丁 | ~130 行（净增 ~30 行） |

### 4.4 对现有 EOF 处理、/exit、/help 的兼容

上述伪代码已包含 `/exit`、`/quit`、`/help` 的处理。Phase 45 的 EOF 优雅退出（inputClosed 哨兵）可以通过 `process.stdin.on('end')` 替代。所有现有功能不受影响。

### 4.5 风险

| 风险 | 缓解 |
|------|------|
| `process.stdin` 流模式下 IME 兼容性 | 需要真机测试豆包输入法。IME 的 compose→commit 流程在流模式下通常没有问题 |
| 多个命令排队堆积 | `pendingInputs` 数组理论上可以无限增长。实际使用中用户最多输入 2-3 条。如果担心，可以限制队列深度为 10 |
| 与 readline 的兼容性 | 需要完全移除 readline。新的 prompt 用 `process.stdout.write` 实现 |

---

## 五、实施计划

### Phase 55：异步输入架构

**改动文件**：`src/cli/cli.ts`（重写 REPL 部分，~130 行替代当前 101 行）

**步骤**：
1. 移除 `createInterface` 和 `rl.question`
2. 设置 `process.stdin` 为 flowing mode
3. 实现行缓冲 + 命令分发
4. 实现 `agentBusy` 状态 + 输入队列
5. 保留 `/exit`、`/quit`、`/help` 和 EOF 处理
6. 移除临时 drain timer（不再需要）

**验证**：
1. 正常对话不受影响
2. agent 运行期间语音输入 → 不卡住，输入被排队
3. agent 完成后自动处理排队输入
4. ANSI prompt 正常显示

### 优先级

**中**。当前 drain timer 临时方案已经阻止了最严重的症状（Terminal 卡死）。Phase 55 是体验优化——让用户在 agent 运行期间不丢失输入。

---

## 六、与其他修复的关系

| 修复 | 解决什么 | 状态 |
|------|---------|------|
| `term-wrap.ts`（折行） | Terminal 崩溃（超长行 → 布局递归） | ✅ 已实施 |
| `cli.ts` drain timer | Terminal 卡死（PTY 输入缓冲区满） | ✅ 已实施（临时） |
| Phase 55（异步输入） | 输入丢失 + 无反馈 | ⏳ 计划中（治本） |

---

## 更新日志

| 日期 | 事件 |
|------|------|
| 2026-08-03 | 初始创建：输入冻结现象 + drain 临时方案 + 异步输入治本方案 |
