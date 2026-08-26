# 重构：合并 run() 和 runSubAgent() 为统一的 agentLoop()

> **创建时间**：2026-08-04
> **学自**：Claude Code — queryLoop() 一份代码驱动主 Agent 和子 Agent
> **目标**：消除 run() 和 runSubAgent() 的 60 行重复，用一个可配置循环替代

---

## 一、现状

```
session_loop.ts
├── run()              ← 主循环 (25轮, sessionMessages, 发ProgressEvent, 返回AgentResult)
└── runSubAgent()      ← 子循环 (10轮, local messages, 不发事件, 返回string)

两个方法里工具执行逻辑完全一样（找工具→调call→格式化结果→推入消息数组）
约60行重复代码。
```

## 二、目标

```
session_loop.ts
└── agentLoop(config)  ← 统一循环

config = {
  messages: ChatMessage[],            // 哪个消息数组（主=sessionMessages, 子=local）
  maxRounds: number,                  // 主=25, 子=10
  onProgress?: (e: ProgressEvent) => void,  // 主=有, 子=undefined
  onTurnComplete?: (msgs, tc) => void,     // 主=有(存盘), 子=undefined
  onComplete?: (text: string) => void,     // 子=completeMember, 主=undefined
  preRoundCheck?: () => string | null,    // 子=检查 pendingInstruction/abort, 主=undefined
  toolUseCallback?: (name, summary, output) => void, // 子=更新 agentLoop 统计
  phase?: (i: number, lastMsg: unknown) => string,  // 主=analyzing/continuing/reviewing, 子="processing"
}
```

## 三、实现

### 3.1 统一循环

```typescript
// session_loop.ts
import type { AgentEngine, ProgressEvent, AgentResult } from './agent_def.js';
import type { ChatMessage } from './llm/types.js';

interface LoopConfig {
  messages: ChatMessage[];
  maxRounds: number;
  onProgress?: (e: ProgressEvent) => void;
  onTurnComplete?: (messages: ChatMessage[], toolCount: number) => void;
  onComplete?: (text: string) => void;
  preRoundCheck?: () => string | null;
  toolUseCallback?: (name: string, summary: string, output: string) => void;
  phaseLabel?: (i: number, lastMsg: unknown) => string;
}

async function agentLoop(
  engine: AgentEngine,
  config: LoopConfig,
): Promise<string> {
  const { messages, maxRounds, onProgress, onTurnComplete, onComplete,
          preRoundCheck, toolUseCallback, phaseLabel } = config;

  for (let i = 0; i < maxRounds; i++) {
    // 子 Agent：检查 pendingInstruction / abort
    if (preRoundCheck) {
      const signal = preRoundCheck();
      if (signal) return signal; // '(killed)' 或 injected instruction
    }

    const lastMsg = messages[messages.length - 1]?.content;
    const phase = phaseLabel
      ? phaseLabel(i, lastMsg)
      : 'processing';

    const response = await (engine as any).callLLM(messages, phase, onProgress);

    if (response.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: response.content });
      const text = (response.content as Array<{ type: string; text?: string }>)
        .filter(b => b.type === 'text').map(b => b.text || '').join('\n');
      const tc = (response.content as Array<{ type: string }>)
        .filter(b => b.type === 'tool_use').length;

      onTurnComplete?.(messages, tc);  // 主Agent: 存盘
      onComplete?.(text);               // 子Agent: completeMember

      return text || '(done)';
    }

    if (response.stop_reason === 'tool_use') {
      const thoughts = (response.content as Array<{ type: string; text?: string }>)
        .filter(b => b.type === 'text').map(b => b.text || '').join(' ').trim();
      if (thoughts && onProgress) {
        onProgress({ type: 'thought', text: thoughts });
      }

      messages.push({ role: 'assistant', content: response.content });

      // === 工具执行（统一） ===
      const toolUses = (response.content as Array<{ type: string; name?: string; id?: string; input?: Record<string, unknown> }>)
        .filter(b => b.type === 'tool_use' && b.name && b.id);

      const toolMap = (engine as any).toolMap;
      const toolContext = (engine as any).toolContext;
      const provider = (engine as any).provider;

      const calls = await Promise.all(toolUses.map(async (b: any) => {
        const tool = toolMap.get(b.name!);
        let output = '';
        if (tool) {
          try {
            const r = await tool.call(b.input || {}, toolContext);
            output = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
          } catch (e) { output = `Error: ${(e as Error).message}`; }
        } else { output = `Unknown tool: ${b.name}`; }

        if (toolUseCallback) {
          const summary = tool?.getToolUseSummary?.(b.input || {}) || b.name!;
          toolUseCallback(b.name!, summary, output);
        }
        return { name: b.name!, id: b.id!, input: b.input || {}, output };
      }));

      if (onProgress) {
        onProgress({ type: 'tool_display', calls: (engine as any).mergeToolCalls(calls) });
      }

      const toolResults: Array<unknown> = [];
      for (const c of calls) {
        toolResults.push(provider.formatToolResult(c.id, c.output));
      }
      if (provider.name === 'openai') {
        for (const tr of toolResults) messages.push(tr as ChatMessage);
      } else {
        messages.push({ role: 'user', content: toolResults });
      }
    } else {
      return `Unexpected: ${response.stop_reason}`;
    }
  }
  return '(max iterations)';
}
```

### 3.2 主 Agent 调用

```typescript
AgentEngine.prototype.run = async function (
  userInput: string,
  onProgress?: (e: ProgressEvent) => void,
): Promise<AgentResult> {
  const startTime = Date.now();
  this.flushNotifications();

  const text = await agentLoop(this, {
    messages: this.sessionMessages,
    maxRounds: 25,
    onProgress,
    onTurnComplete: (msgs, tc) => this.onTurnComplete?.(msgs, tc),
    phaseLabel: (i, lastMsg) => i === 0 ? 'analyzing' :
      typeof lastMsg === 'string' && lastMsg.length < 200 ? 'continuing' : 'reviewing results',
  });

  return { text, ms: Date.now() - startTime };
};
```

### 3.3 子 Agent 调用

```typescript
AgentEngine.prototype.runSubAgent = async function (
  taskPrompt: string,
  agentId: string,
): Promise<string> {
  const task = this.team.get(agentId);
  if (task) task.status = 'running';

  const messages: ChatMessage[] = [
    { role: 'user', content: `Complete this task:\n${taskPrompt}\n\nReturn a concise report.` },
  ];

  try {
    return await agentLoop(this, {
      messages,
      maxRounds: 10,
      onComplete: (text) => this.completeMember(agentId, text),
      preRoundCheck: () => {
        if (task?.pendingInstruction) {
          messages.push({ role: 'user', content: `[MAIN AGENT INSTRUCTION — follow this]: ${task.pendingInstruction}` });
          task.pendingInstruction = undefined;
          return null;
        }
        if (task?.abortController?.signal.aborted) {
          if (task) { task.status = 'killed'; task.endTime = Date.now(); }
          return '(killed)';
        }
        return null;
      },
      toolUseCallback: (name, summary, output) => {
        if (task?.agentLoop) {
          task.agentLoop.lastActivity = `${name}(${summary})`;
          task.agentLoop.lastOutput = output.slice(0, 200);
        }
      },
    });
  } catch (e) {
    return `(crashed: ${(e as Error).message})`;
  }
};
```

## 四、文件变化

| 文件 | 改动 |
|------|------|
| `src/session_loop.ts` | 重写：agentLoop() + run() + runSubAgent() 三个函数，~200行 |
| `src/agent_def.ts` | 不变 |
| `src/Mycoder.ts` | 不变 |
| `src/cli/cli.ts` | 不变 |

净变化：消除 ~60 行重复代码。session_loop.ts 从 157 行到 ~200 行。

## 五、验证

| # | 场景 | 期望 |
|---|------|------|
| 1 | 主 Agent 对话 | 和现在完全一致 |
| 2 | 子 Agent 执行 | 和现在完全一致 |
| 3 | 子 Agent pendingInstruction | 正确注入 |
| 4 | 子 Agent abort | 正确 kill |
| 5 | 主 Agent 存盘 | onTurnComplete 被调 |
| 6 | 编译 | 零错误 |
