# 明日计划：解耦 Agent 组织方式

> **创建时间**：2026-08-03
> **目标日期**：2026-08-04
> **前置**：管道设计讨论

---

## 一、做什么

从最小步开始——把 agent.ts 里 `run()` 和 `runSubAgent()` 重复的工具执行代码（~60 行 × 2）抽成一个共享的 `executeToolCalls()` 私有方法。

不引入新文件、不引入 Stage 抽象、不引入 AgentContext。只做消除重复 + 验证解耦可行性。

## 二、当前重复代码

```typescript
// run() L241-270 — 主 Agent 版本
const calls = await Promise.all(toolUses.map(async b => {
  const tool = this.toolMap.get(b.name!);
  let toolOutput: string;
  if (tool) {
    try {
      const result = await tool.call(b.input || {}, this.toolContext);
      toolOutput = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    } catch (e) { toolOutput = `Error: ${(e as Error).message}`; }
  } else { toolOutput = `Unknown tool: ${b.name}`; }
  return { name: b.name!, id: b.id!, input: b.input || {}, output: toolOutput };
}));
// onProgress + mergeToolCalls + formatToolResult + push

// runSubAgent() L317-344 — 几乎一样，但多了 agentLoop 统计
```

## 三、抽离方案

```typescript
private async executeToolCalls(
  toolUses: Array<{ type: string; name?: string; id?: string; input?: Record<string, unknown> }>,
  opts?: {
    onProgress?: (e: ProgressEvent) => void;   // 主Agent：发显示事件
    updateStats?: (name: string, summary: string, output: string) => void; // 子Agent：写agentLoop
  },
): Promise<void> {
  const validUses = toolUses.filter(b => b.type === 'tool_use' && b.name && b.id);

  const calls = await Promise.all(validUses.map(async b => {
    const tool = this.toolMap.get(b.name!);
    let output: string;
    if (tool) {
      try {
        const r = await tool.call(b.input || {}, this.toolContext);
        output = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      } catch (e) { output = `Error: ${(e as Error).message}`; }
    } else { output = `Unknown tool: ${b.name}`; }

    if (opts?.updateStats) {
      const summary = tool?.getToolUseSummary?.(b.input || {}) || b.name!;
      opts.updateStats(b.name!, summary, output);
    }
    return { name: b.name!, id: b.id!, input: b.input || {}, output };
  }));

  // 合并 + 显示（主Agent 才需要）
  if (opts?.onProgress) {
    opts.onProgress({ type: 'tool_display', calls: this.mergeToolCalls(calls) });
  }

  // 格式化结果 + 注入消息
  for (const c of calls) {
    const tr = this.provider.formatToolResult(c.id, c.output);
    if (this.provider.name === 'openai') {
      this.sessionMessages.push(tr as ChatMessage);
    } else {
      toolResults.push(tr);
    }
  }
  if (this.provider.name !== 'openai') {
    this.sessionMessages.push({ role: 'user', content: toolResults });
  }
}
```

## 四、run() 变化

之前 ~30 行工具执行代码 → 变成一行：

```typescript
await this.executeToolCalls(toolUses, { onProgress });
```

## 五、runSubAgent() 变化

```typescript
await this.executeToolCalls(toolUses, {
  updateStats: (name, summary, output) => {
    if (task?.agentLoop) {
      task.agentLoop.lastActivity = `${name}(${summary})`;
      task.agentLoop.lastOutput = output.slice(0, 200);
    }
  },
});
```

## 六、验证

| # | 场景 | 期望 |
|---|------|------|
| 1 | 主 Agent 调工具 → 终端显示 | 工具名+摘要正确显示 |
| 2 | 子 Agent 调工具 → Terminal 静默 | 不显示，但 agentLoop 统计更新 |
| 3 | 工具执行异常 | 错误信息正常返回，不崩 |
| 4 | 合并显示（Read ×4） | 合并逻辑不变 |
| 5 | 编译 | 零错误 |

## 七、不做的事

- 不引入 AgentContext
- 不拆 Stage 文件
- 不改引擎的外部接口（run() 签名不变）
- 目标：一个私有方法，消除重复，验证解耦可行性
