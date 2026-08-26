# 设计方案

## 冗余 1：`private tools` 死字段（agent_def.ts L61）

**现状**：`this.tools = tools` 只在 constructor 里用——建 `toolMap` 和 `toolContext`。之后从未读取。

**改法**：删掉字段声明，改为局部变量。

```typescript
// 删: private tools: Tools;
// constructor 里:
const tools = toolsParam;
this.toolMap = new Map(tools.map(t => [t.name, t]));
```

## 冗余 2：`buildSystemPrompt` 重复创建 ConfigStore

**现状**：每次构建提示词都 `new ConfigStore().loadMemory()`。ConfigStore 在 Mythinknode.ts 已经有一个了。

**改法**：构造函数里读一次 memory，存为 `this.userMemory`。`buildSystemPrompt` 直接用。

```typescript
// constructor 加:
this.userMemory = new ConfigStore().loadMemory();
// buildSystemPrompt 里:
const memory = this.userMemory;
```

## 冗余 3：WebSearchTool 绕过工具抽象读 config

**现状**：`WebSearchTool.ts` import `loadConfig`，在 `call()` 里读 `tavilyApiKey`。这绕过了 toolContext——其他工具不需要这种全局访问。

**改法**：方案 A——把 `tavilyApiKey` 挂到 `toolContext.options` 上（AgentEngine 构造时传入）。方案 B——让 WebSearchTool 在 `call()` 里通过 `ctx.engine.config.tavilyApiKey` 读。

**选方案 A**：改动最小，不引入引擎引用。

```typescript
// agent_def.ts constructor:
this.toolContext = {
  options: { tools, ..., tavilyApiKey: config.tavilyApiKey },
  ...
};

// WebSearchTool call():
const key = ctx.options.tavilyApiKey;
```

## 耦合分析

### 耦合点 1：ProgressEvent 类型在 CLI 文件夹，被后端 import

```
agent_def.ts ← import { ToolCall, MergedTool, ProgressEvent } from './cli/monitor/progress.js'
query_loop.ts ← 同上
```

这是故意的——"前端定合同，后端遵守"。但如果有一天换前端（Web），这套类型就不适用了。当前可以接受。

### 耦合点 2：AgentTool → agent_def.js（双向）

```
AgentTool.ts → import type { MemberState } from agent_def.js  ← 类型依赖（OK）
AgentTool.ts → import { SUB_AGENT_PROMPT } from agent_def.js  ← 值依赖（耦合）
```

SUB_AGENT_PROMPT 是工具 prompt 文本，放在引擎文件里不合理。可以移到 AgentTool 自己的 prompt.ts 里。

### 耦合点 3：session_loop import query_loop

```
session_loop.ts → import { agentLoop } from './query_loop.js'
```

这是正常的层间调用——Session 循环调用 Query 循环。不是耦合。

### 耦合点 4：Mythinknode 知道所有模块

```
Mythinknode.ts → 6 个 import（agent_def, session, session_loop, cli, config, llm）
```

入口文件知道所有模块是正常的——它就是接线员。不是耦合。
