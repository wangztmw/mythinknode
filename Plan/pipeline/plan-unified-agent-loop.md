# 重构：统一 Agent 循环 — 最终计划

> **创建时间**：2026-08-04
> **最终版本**：2026-08-05（三个 Agent 全量调查后定稿）
> **学自**：Claude Code queryLoop() + 四层子Agent消息隔离
> **前置分析**：subagent-message-lifecycle.md + cc-subagent-isolation.md + plan-analysis-risks.md + plan-analysis-implementation.md
> **实施方式**：一次性替换——不保留 run()/runSubAgent()，不逐步迁移

---

## 〇、为什么一次性而不是逐步

逐步迁移意味着主 Agent 跑 `agentLoop`、子 Agent 还跑 `runSubAgent()`——两套代码路径共存。但我们做这个重构的根本目的是**让系统统一控制**——后面还有管道化、角色化集群等更大升级。两套路径共存只是在旧架构上打补丁，不是真正的统一。

**一次到位。** 旧的方法删除，新的 `agentLoop()` 是唯一入口。cli.ts 和 AgentTool 同时切到新路径。

---

## 一、当前保护机制（必须保留的）

### ★ 关键发现：子 Agent 工具执行是串行的，不是并行的

调查发现 `run()` 和 `runSubAgent()` 在工具执行上有**隐藏差异**：

```typescript
// run() —— 主Agent：Promise.all 并行
const calls: ToolCall[] = await Promise.all(toolUses.map(async b => {
  const tool = this.toolMap.get(b.name!);
  // ...
}));

// runSubAgent() —— 子Agent：for-of 串行！
for (const block of response.content) {
  const b = block as { type: string; name?: string; id?: string; input?: unknown };
  if (b.type === 'tool_use' && b.name && b.id) {
    const tool = this.toolMap.get(b.name);
    const r = await tool.call(b.input || {}, this.toolContext);
    // 一个接一个，等上一个完全结束才开始下一个
  }
}
```

**为什么子 Agent 是串行的？** 可能不是刻意设计——更多是"当时写的代码不同"。但串行执行确实保护了一个场景：如果 LLM 在同一个回合里先调 `Read(file)` 再调 `Edit(file, ...)`，串行保证 Read 的结果先回来，Edit 再执行。并行的话 Edit 可能在 Read 完成前就开始跑，读到旧内容或报错。

**合并后怎么处理？** `executeTools()` 加 `serialTools?: boolean` 参数。主 Agent 不传（默认并行），子 Agent 传 `true`（保持串行）。当前行为不变。等以后验证了子 Agent 的并行安全性再统一。

### 并行/串行的实现

```typescript
async function executeTools(
  engine: AgentEngine,
  response: any,
  onProgress?: (e: ProgressEvent) => void,
  updateStats?: (name: string, summary: string, output: string) => void,
  serial?: boolean,
): Promise<ToolCall[]> {
  const toolUses = (response.content as any[])
    .filter(b => b.type === 'tool_use' && b.name && b.id);

  const executeOne = async (b: any): Promise<ToolCall> => {
    const tool = (engine as any).toolMap.get(b.name!);
    let output = '';
    if (tool) {
      try {
        const r = await tool.call(b.input || {}, (engine as any).toolContext);
        output = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      } catch (e) { output = `Error: ${(e as Error).message}`; }
    } else { output = `Unknown tool: ${b.name}`; }
    if (updateStats) {
      const summary = tool?.getToolUseSummary?.(b.input || {}) || b.name!;
      updateStats(b.name!, summary, output);
    }
    return { name: b.name!, id: b.id!, input: b.input || {}, output };
  };

  // ★ 主Agent：Promise.all 并行。子Agent：reduce 串行
  const calls = serial
    ? await toolUses.reduce(async (prev, b) => {
        const acc = await prev;
        acc.push(await executeOne(b));
        return acc;
      }, Promise.resolve([] as ToolCall[]))
    : await Promise.all(toolUses.map(executeOne));

  if (onProgress) {
    onProgress({ type: 'tool_display', calls: (engine as any).mergeToolCalls(calls) });
  }
  return calls;
}
```

**reduce 串行的原理**：`reduce` 每一步 `await prev` 等前一个工具完成，才 `executeOne(b)` 下一个。等价于串行的 `for` 循环，但保持了函数式风格。

**何时可以统一为并行？** 当 Phase 51（子 Agent 工具权限）实施后，子 Agent 被限制为只读工具（Read/WebSearch/Grep/Glob），不再有 Write/Edit。只读工具之间无数据依赖——全部可以安全并行。届时去掉 `serialTools` 参数，统一用 `Promise.all`。

### 子 Agent 消息数组的完整生命周期

```
AgentTool.call()
  ├─ addMember('local_agent', description)
  ├─ const messages = [{ role:'user', content: taskPrompt }]   ← ① 创建
  │
  └─ agentLoop(engine, { messages, maxRounds:10, onComplete, ... })
       │
       ├─ for (10轮):
       │    messages.push(assistant回复)    ← ② 累积
       │    messages.push(tool_result)       ← ③ 累积
       │
       ├─ end_turn → text = extractText(response)
       │              onComplete(text)            ← ④ 只传最终文字
       │              return text                 ← ⑤ 返回字符串
       │
       └─ local messages → GC 销毁            ← ⑥ 函数结束，数组消失

AgentTool 收到 result (string):
  background: completeMember + notify
  sync:       completeMember + return { data: result }
```

**五层隔离全部保留**：

1. AgentTool 创建 `messages` 局部数组 → 传入 agentLoop
2. `messages` 是 `const`，函数作用域 → 不挂 `this`
3. `agentLoop` 用传入的 `messages` 调 `callLLM` → 不碰 `this.sessionMessages`
4. 完成时 `onComplete(text)` — 只传 text 字符串，不是数组
5. 函数返回后 `messages` 销毁 → GC

---

## 二、合并设计

### 2.1 唯一循环函数

```typescript
// session_loop.ts

interface AgentLoopParams {
  messages: ChatMessage[];                    // ① 消息数组 — 谁调用谁传入
  maxRounds: number;                          // ② 轮次上限
  onProgress?: (e: ProgressEvent) => void;     // ③ 进度回调 — 主传，子不传
  onTurnComplete?: (msgs: ChatMessage[], tc: number) => void;  // ④ 存盘 — 主传
  onComplete?: (text: string) => void;         // ⑤ 完成回调 — 子传 completeMember
  preRoundCheck?: (messages: ChatMessage[]) => string | null;  // ⑥ 轮前检查 — 子传
  updateStats?: (name: string, summary: string, output: string) => void; // ⑦ 统计 — 子传
  phaseLabel?: (i: number, lastMsg: unknown) => string;        // ⑧ 阶段标签 — 主传
  serialTools?: boolean;                       // ⑨ 工具执行模式 — 子传true，主默认false
}

async function agentLoop(
  engine: AgentEngine,
  params: AgentLoopParams,
): Promise<string> {
  const { messages, maxRounds, onProgress, onTurnComplete, onComplete,
          preRoundCheck, updateStats, phaseLabel, serialTools } = params;

  for (let i = 0; i < maxRounds; i++) {
    if (preRoundCheck) {
      const signal = preRoundCheck(messages);
      if (signal) return signal;
    }

    const lastMsg = messages[messages.length - 1]?.content;
    const phase = phaseLabel?.(i, lastMsg) ?? 'processing';

    const response = await (engine as any).callLLM(messages, phase, onProgress);

    if (response.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: response.content });
      const text = extractText(response);
      const tc = countToolUses(response);
      onTurnComplete?.(messages, tc);   // 主Agent: 存盘
      onComplete?.(text);                // 子Agent: completeMember
      return text || '(done)';
    }

    if (response.stop_reason === 'tool_use') {
      const thoughts = extractThoughts(response);
      if (thoughts && onProgress) onProgress({ type: 'thought', text: thoughts });
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = await executeTools(engine, response, onProgress, updateStats, serialTools);
      pushResults(messages, engine, toolResults);
    } else {
      return `Unexpected: ${response.stop_reason}`;
    }
  }
  return '(max iterations)';
}
```

### 2.2 辅助函数

```typescript
function extractText(response: any): string {
  return (response.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text').map(b => b.text || '').join('\n');
}

function countToolUses(response: any): number {
  return (response.content as Array<{ type: string }>)
    .filter(b => b.type === 'tool_use').length;
}

function extractThoughts(response: any): string {
  return (response.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text').map(b => b.text || '').join(' ').trim();
}

async function executeTools(
  engine: AgentEngine,
  response: any,
  onProgress?: (e: ProgressEvent) => void,
  updateStats?: (name: string, summary: string, output: string) => void,
  serial?: boolean,
): Promise<Array<{ name: string; id: string; input: Record<string, unknown>; output: string }>> {
  const toolUses = (response.content as any[])
    .filter(b => b.type === 'tool_use' && b.name && b.id);
  const toolMap = (engine as any).toolMap;
  const toolContext = (engine as any).toolContext;

  const executeOne = async (b: any) => {
    const tool = toolMap.get(b.name!);
    let output = '';
    if (tool) {
      try {
        const r = await tool.call(b.input || {}, toolContext);
        output = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      } catch (e) { output = `Error: ${(e as Error).message}`; }
    } else { output = `Unknown tool: ${b.name}`; }
    if (updateStats) {
      const summary = tool?.getToolUseSummary?.(b.input || {}) || b.name!;
      updateStats(b.name!, summary, output);
    }
    return { name: b.name!, id: b.id!, input: b.input || {}, output };
  };

  // ★ 关键：子Agent串行，主Agent并行
  const calls = serial
    ? await toolUses.reduce(async (prev, b) => {
        const acc = await prev;
        acc.push(await executeOne(b));
        return acc;
      }, Promise.resolve([] as any[]))
    : await Promise.all(toolUses.map(executeOne));

  if (onProgress) {
    onProgress({ type: 'tool_display', calls: (engine as any).mergeToolCalls(calls) });
  }
  return calls;
}

function pushResults(
  messages: ChatMessage[],
  engine: AgentEngine,
  toolCalls: Array<{ id: string; output: string }>,
): void {
  const provider = (engine as any).provider;
  const toolResults: Array<unknown> = [];
  for (const c of toolCalls) toolResults.push(provider.formatToolResult(c.id, c.output));
  if (provider.name === 'openai') {
    for (const tr of toolResults) messages.push(tr as ChatMessage);
  } else {
    messages.push({ role: 'user', content: toolResults });
  }
}
```

### 2.3 主 Agent 调用

```typescript
// cli.ts 中：
const startTime = Date.now();
engine.flushNotifications();
engine.sessionMessages.push({ role: 'user', content: userInput });

const resultText = await agentLoop(engine, {
  messages: engine.sessionMessages,
  maxRounds: 25,
  onProgress: renderProgress,
  onTurnComplete: (msgs, tc) => engine.onTurnComplete?.(msgs, tc),
  phaseLabel: (i, lastMsg) => i === 0 ? 'analyzing' :
    typeof lastMsg === 'string' && lastMsg.length < 200 ? 'continuing' : 'reviewing results',
  // serialTools 不传 → 默认 false → 并行
});

const result = { text: resultText, ms: Date.now() - startTime };
```

### 2.4 子 Agent 调用

```typescript
// AgentTool.call() 中：
const task = addMember('local_agent', description, prompt.slice(0, 200));
const messages: ChatMessage[] = [
  { role: 'user', content: `Complete this task:\n${taskPrompt}\n\nReturn a concise report.` },
];

try {
  const result = await agentLoop(engine, {
    messages,
    maxRounds: 10,
    serialTools: true,  // ★ 子Agent保持串行——当前行为不变
    onComplete: (text) => engine.completeMember(task.id, text),
    preRoundCheck: () => {
      if (task?.pendingInstruction) {
        messages.push({ role: 'user', content: `[MAIN AGENT INSTRUCTION]: ${task.pendingInstruction}` });
        task.pendingInstruction = undefined;
        return null;
      }
      if (task?.abortController?.signal.aborted) {
        task.status = 'killed';
        return '(killed)';
      }
      return null;
    },
    updateStats: (name, summary, output) => {
      if (task?.agentLoop) {
        task.agentLoop.lastActivity = `${name}(${summary})`;
        task.agentLoop.lastOutput = output.slice(0, 200);
      }
    },
  });

  completeMember(task.id, result);
  return { data: `[Agent "${description}" report]:\n${result}` };
} catch (e) {
  return { data: `Agent error: ${(e as Error).message}` };
}
```

### 2.5 InitAgentTool 签名变更

```typescript
// Mycoder.ts —— 简化：
initAgentTool({
  taskRegistry: teamReg,
  engine,          // ← 传入 engine 实例
  agentLoop,       // ← 传入 agentLoop 函数
  notify: (msg: string) => engine.notify(msg),
});

// AgentTool.ts —— 接收新签名：
export function initAgentTool(deps: {
  taskRegistry: Map<string, any>;
  engine: AgentEngine;
  agentLoop: typeof agentLoop;
  notify: (msg: string) => void;
}) {
  _engine = deps.engine;
  _agentLoop = deps.agentLoop;
  _tasks = deps.taskRegistry;
  _notify = deps.notify;
}
```

---

## 三、文件变化

| 文件 | 变化 | 行数 |
|------|------|------|
| `src/session_loop.ts` | 删除 run()/runSubAgent() prototype。新增 agentLoop() + 4个辅助函数 | 157→~185 |
| `src/agent_def.ts` | 删除 run()/runSubAgent() 桩方法 | -4 |
| `src/cli/cli.ts` | engine.run() → agentLoop(engine, {...}) | +10/-5 |
| `src/tools-v2/AgentTool/AgentTool.ts` | 改用 agentLoop + 加 try-catch | +15/-10 |
| `src/Mycoder.ts` | 删 buildSubAgentContext 死代码 + runSubAgent wrapper。initAgentTool 签名简化 | -15 |

**净增** ~25 行。消除 60 行重复 + 15 行死代码。

---

## 四、被保护的五层隔离

| 保护 | 合并后怎么保证 |
|------|--------------|
| **消息数组隔离** | `messages`由调用者传入——cli.ts 只有 sessionMessages，AgentTool 只有局部变量。物理隔离 |
| **进度不泄露** | `onProgress` 可选——子Agent 不传，自动跳过 |
| **错误隔离** | agentLoop 内部不 try-catch——cli.ts 和 AgentTool 各自捕获 |
| **状态不交叉** | `updateStats` 只写 task.agentLoop——主Agent 不传此回调 |
| **生命周期独立** | `onComplete` 只子Agent 传——主Agent 走 onTurnComplete |

---

## 五、一并修复的 Bug

| # | Bug | 修复 |
|---|-----|------|
| 1 | `buildSubAgentContext` 是死代码 | 删除。AgentTool 自己建 messages |
| 2 | 崩溃子Agent 被标记 completed | agentLoop 不内部 catch。调用者 catch → 设 status='failed' |
| 3 | `completeMember` 被调两次 | onComplete 回调，agentLoop 内部不调 completeMember |
| 4 | `toolContext.abortController` 共享 | Phase 54 独立修复（本次不改） |
| 5 | 最大迭代 vs 完成无法区分 | agentLoop 返回 '(max iterations)' 时 onComplete 不调 |

---

## 六、实施步骤（一次性）

1. **改 session_loop.ts**：写 agentLoop + 辅助函数，删 prototype 挂载
2. **改 agent_def.ts**：删 run()/runSubAgent() 桩
3. **改 cli.ts**：切到 agentLoop
4. **改 AgentTool.ts**：切到 agentLoop（加 try-catch + serialTools=true）
5. **改 Mycoder.ts**：删 dead code + 更新 initAgentTool 签名
6. **编译 + 全量验证**

---

## 七、验证清单（23 项）

| # | 场景 | 验证方法 |
|---|------|---------|
| 1 | 主Agent对话 | `echo "你好" \| node dist/Mycoder.js` |
| 2 | 子Agent执行 | 调 Agent(description, prompt) |
| 3 | 子Agent消息隔离 | grep sessionMessages 确认无子Agent内部工具调用 |
| 4 | pendingInstruction | AgentTeam(direct, "改方向") |
| 5 | abort | AgentTeam(kill, id) |
| 6 | 主Agent存盘 | 检查 `~/.mycoder/sessions/` |
| 7 | 子Agent磁盘输出 | 检查 `~/.mycoder/team/{id}.txt` |
| 8 | onProgress 不泄露 | 子Agent运行期间终端安静 |
| 9 | 编译 | `npm run build` |
| 10 | 子Agent串行工具 | 调 Agent 触发 Read+Edit 同一轮 → 串行执行 |
| 11 | 主Agent并行工具 | 主循环中 Promise.all 正常 |
| 12 | 子Agent崩溃 → failed | 模拟崩溃 → 检查 task.status |
| 13 | max iterations → 不调 onComplete | 10轮用完 → result='(max iterations)' |
| 14 | 主Agent并发子Agent | 同时 spawn 3个后台子Agent |
| 15 | 子Agent创建子Agent | 嵌套调用（如果Agent工具没被 砍掉） |
| 16 | LLM返回 max_tokens | 超长对话中验证 |
| 17 | 网络错误 | 模拟断网 → callLLM throw → 调用者catch |
| 18 | 工具执行失败 | Read 不存在文件 → 循环继续 |
| 19 | 空 messages | agentLoop 空数组 → 验证不崩 |
| 20 | 编译 strict 模式 | `tsc --noEmit --strict` |
| 21 | 全量回归 | 跑三组完整对话（简单/复杂/多Agent） |
| 22 | 旧引用清理 | grep 确认无 engine.run / engine.runSubAgent / buildSubAgentContext 残留 |
| 23 | 内存 | 50 轮主Agent → 无泄漏 |
