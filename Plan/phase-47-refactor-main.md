# Phase 47 计划：main.ts 模块化重构

> **创建时间**：2026-08-02
> **状态**：✅ 已实施并验证完成（2026-08-02）
> **核心文件**：`src/main.ts`（500 行 → 目标 120 行）
> **重构类型**：架构分层（不改变功能，只重组结构）
> **风险等级**：中（涉及所有模块的拆分和重新连线）

---

## 一、为什么要重构

### 当前问题

`src/main.ts` 500 行塞了 7 个职责，5 组全局可变状态，3 个位置的 Provider 格式转换。每次改一个功能都要穿越不相关的代码。Phase 45/46 的改动已经让文件进一步膨胀。

### 不改会怎样

每次加新功能就往 main.ts 塞 → 500 → 700 → 1000 行 → 最终变成第二个 Claude Code（原始 main.ts 914 行）。**现在就是重构的最佳时机。**

---

## 二、目标架构

```
src/
├── main.ts               ~120 行  薄壳：启动 + 连线
├── cli.ts                ~80 行   REPL 循环（独立可测试）
├── agent.ts              ~120 行  核心 Agent 引擎
├── task.ts               ~60 行   Task 生命周期
├── llm/
│   ├── types.ts          ~30 行   统一 Provider 接口
│   ├── anthropic.ts      ~60 行   Anthropic 调用
│   └── openai.ts         ~60 行   OpenAI/DeepSeek 调用
├── ansi.ts               ~60 行   Markdown→ANSI（直接移出）
├── provider.ts           ~40 行   Provider 检测 + 配置
└── tools-v2/             现有     不变
```

**总行数变化**：500 → ~630（拆分后略增，因为多了接口定义和 import，但每个文件职责单一）

---

## 三、拆分细节

### 3.1 `src/provider.ts` — Provider 检测（≈40 行）

**移入**：main.ts 20-44 行

```ts
// 输入：process.env
// 输出：{ apiKey, provider, model, openaiBase }
export function detectProvider(): ProviderConfig { ... }
```

**纯函数**，无副作用。输入环境变量，输出配置对象。

### 3.2 `src/llm/types.ts` — 统一接口（≈30 行）

```ts
export interface ChatMessage { role: string; content: string | Array<unknown>; }
export interface LLMResponse { content: Array<unknown>; stop_reason: string; }

// 消息格式翻译器
export interface MessageTranslator {
  toAPI(messages: ChatMessage[], systemPrompt: string): unknown;
  fromAPI(raw: unknown): LLMResponse;
}

// 工具格式生成器
export interface ToolFormatter {
  formatTools(tools: ToolDef[]): unknown;
  formatToolResult(toolUseId: string, output: string): ChatMessage;
}
```

**关键设计**：不再在 3 个地方分别处理 Anthropic/OpenAI 格式差异——全部收敛到 `MessageTranslator` 和 `ToolFormatter` 两个接口。

### 3.3 `src/llm/anthropic.ts` — Anthropic 调用（≈60 行）

**移入**：main.ts 53-56（TOOLS_ANTHROPIC）+ 79-96（callLLM_Anthropic）+ 282-288（tool_result 格式）

```ts
export const anthropicProvider: LLMProvider = {
  translateMessages,  // user/assistant 格式
  formatTools,        // { name, description, input_schema }
  formatToolResult,   // { type: 'tool_result', tool_use_id, content }
  call,               // POST /v1/messages
};
```

### 3.4 `src/llm/openai.ts` — OpenAI/DeepSeek 调用（≈60 行）

**移入**：main.ts 59-61（TOOLS_OPENAI）+ 98-138（callLLM_OpenAI）+ 279-281（tool 格式）

```ts
export const openaiProvider: LLMProvider = {
  translateMessages,  // system/user/assistant/tool 格式，含 tool_calls 转换
  formatTools,        // { type: 'function', function: { name, description, parameters } }
  formatToolResult,   // { role: 'tool', tool_call_id, content }
  call,               // POST /v1/chat/completions
};
```

### 3.5 `src/ansi.ts` — Markdown→ANSI（≈60 行）

**移入**：main.ts 397-446 行（mdToANSI 函数 + ANSI 常量）

纯函数，零依赖，直接搬。

### 3.6 `src/task.ts` — Task 生命周期（≈60 行）

**移入**：main.ts 298-318 行（TaskState、taskRegistry、createTask、completeTask）

```ts
export interface TaskState { ... }
export function createTask(...): TaskState { ... }
export function completeTask(...): void { ... }
export function getTaskRegistry(): Map<string, TaskState> { ... }
```

### 3.7 `src/agent.ts` — 核心引擎（≈120 行）

**移入**：main.ts 160-293 行（buildSystemPrompt、runAgent、callLLM 包装、sessionMessages 管理）+ 320-392 行（runSubAgent、SUB_AGENT_PROMPT）

```ts
export class AgentEngine {
  private sessionMessages: ChatMessage[];
  private pendingNotifications: Array<...>;
  private provider: LLMProvider;
  
  constructor(provider: LLMProvider, tools: ToolDef[]) { ... }
  
  async run(userInput: string): Promise<string> { ... }    // 主 Agent 循环
  async runSubAgent(taskPrompt: string): Promise<string> { ... }  // 子 Agent
  
  flushNotifications(): void { ... }
  buildSystemPrompt(): string { ... }
}
```

**关键改变**：`sessionMessages` 从全局变量变成实例属性。不再有 `_isSubAgent` 全局开关——子 Agent 用自己的 `AgentEngine` 实例。

### 3.8 `src/cli.ts` — REPL 循环（≈80 行）

**移入**：main.ts 448-499 行（readline + EOF 处理 + while 循环）

```ts
export async function startCLI(engine: AgentEngine) {
  // readline 设置 + Phase 45 EOF 处理 + while(true) 循环
  // 不直接访问 sessionMessages——通过 engine.run() 
}
```

### 3.9 `src/main.ts` — 入口（≈120 行）

```ts
import { detectProvider } from './provider.js';
import { AnthropicProvider } from './llm/anthropic.js';
import { OpenAIProvider } from './llm/openai.js';
import { AgentEngine } from './agent.js';
import { startCLI } from './cli.js';
import { getAllTools } from './tools-v2/index.js';

function main() {
  const config = detectProvider();
  const provider = config.provider === 'anthropic' ? AnthropicProvider : OpenAIProvider;
  const tools = getAllTools();
  const engine = new AgentEngine(provider, tools, config);
  
  printBanner(config);
  startCLI(engine);
}

main().catch(console.error);
```

**只剩连线逻辑**。一目了然：检测配置 → 选 Provider → 加载工具 → 启动引擎 → 进入 REPL。

---

## 四、全局状态消除方案

| 当前全局变量 | 目标位置 |
|------------|---------|
| `API_KEY` / `PROVIDER` / `MODEL` | `provider.ts` → `ProviderConfig` 对象 |
| `SYSTEM_PROMPT` | `AgentEngine` 实例属性 |
| `sessionMessages` | `AgentEngine` 实例属性 |
| `pendingNotifications` | `AgentEngine` 实例属性 |
| `_isSubAgent` | **消除**：子 Agent 用独立 `AgentEngine` 实例 |
| `_thinkStart` / `_thinkLabel` | `callLLM` 内部局部变量 |
| `taskRegistry` | `task.ts` 模块闭包（不导出到全局） |

---

## 五、不做的事（明确边界）

| 不做 | 原因 |
|------|------|
| 改 tools-v2/ 架构 | 工具系统已经很好（buildTool 工厂 + 每工具一目录） |
| 引入依赖注入框架 | 杀鸡用牛刀——手动连线 5 个模块就够 |
| 改 Agent 循环逻辑 | 只搬代码，不改行为 |
| 改 Provider 调用参数 | 只搬代码，不改 API 调用逻辑 |
| TDD/加测试 | Phase 47 只做结构重组，测试放 Phase 48 |

---

## 六、执行顺序（9 步）

```
Step 1: 创建 provider.ts — 抽 Provider 检测（纯函数，无依赖）
Step 2: 创建 llm/types.ts — 定义接口
Step 3: 创建 llm/anthropic.ts — 搬 Anthropic 调用
Step 4: 创建 llm/openai.ts — 搬 OpenAI 调用
Step 5: 创建 ansi.ts — 搬 ANSI 渲染（纯函数）
Step 6: 创建 task.ts — 搬 Task 系统
Step 7: 创建 agent.ts — 搬 Agent 引擎（最复杂，依赖前 6 步）
Step 8: 创建 cli.ts — 搬 REPL
Step 9: 重写 main.ts — 只留连线
```

每步完成后 `npx tsc --noEmit` 验证。最后 `node dist/main.js` 跑 `/help` + `/exit` 冒烟测试。

---

## 七、风险与回滚

| 风险 | 缓解 |
|------|------|
| 拆分后连线错误 | 每步编译验证，不攒到最后 |
| 子 Agent 全局状态迁移遗漏 | `_isSubAgent` 消除是关键——改用独立 AgentEngine 实例 |
| sessionMessages 迁移破坏跨轮对话 | `AgentEngine` 保持 messages 数组不变 |
| 性能退化 | 纯搬代码，不增加任何调用层级 |

**回滚方案**：git tag 当前 commit，出问题直接 `git reset --hard`。

---

## 八、实施清单

- [x] Step 1: `src/provider.ts` — Provider 检测（41行，纯函数）
- [x] Step 2: `src/llm/types.ts` — 统一接口（38行）
- [x] Step 3: `src/llm/anthropic.ts` — Anthropic Provider（53行）
- [x] Step 4: `src/llm/openai.ts` — OpenAI/DeepSeek Provider（100行）
- [x] Step 5: `src/ansi.ts` — Markdown→ANSI（56行）
- [x] Step 6: `src/task.ts` — Task 生命周期（46行）
- [x] Step 7: `src/agent.ts` — Agent 引擎（294行，全局状态全部消除）
- [x] Step 8: `src/cli.ts` — REPL 循环（60行）
- [x] Step 9: `src/main.ts` — 重写为薄壳入口（65行，缩减87%）
- [x] `npx tsc --noEmit` 全流程零错误
- [x] 冒烟测试：`/help` + `/exit` + 管道 EOF

### 验证结果（2026-08-02）

| 测试 | 结果 |
|------|------|
| TypeScript 编译 | ✅ 零错误 |
| /help 命令 | ✅ 显示 12 个工具 |
| /exit 命令 | ✅ Bye. + code=0 |
| EOF 优雅退出 | ✅ Bye. + code=0 |
| Provider 检测 | ✅ sk- 前缀 → openai |
| 版本号 | ✅ v0.4.0 |

### 重构成果

| 指标 | 重构前 | 重构后 |
|------|--------|--------|
| main.ts 行数 | 500 | **65**（-87%） |
| 文件数 | 27 | **35** |
| 总行数 | 1,516 | **1,769**（+253，接口定义和 import 开销） |
| 全局可变状态 | 7 个 | **0 个** |
| Provider 格式转换 | 散落 3 处 | 收敛到 2 个 Provider 类 |
| 最大文件 | main.ts（500） | agent.ts（294） |
