# my-coder：多 Agent 并行执行方案

> **创建时间**：2026-08-01
> **状态**：设计草案（待评审）
> **核心目标**：在现有单 Agent 基础上，增加真正的「多 Agent 并发执行」能力

---

## 一、背景与现状

### 1.1 当前架构（单 Agent）

`src/main.ts` 是唯一的执行入口，AGENT 循环为**串行单线程**：

```
main()
 └─ runAgent(userInput)
     └─ for (i < 25) 循环
         ├─ callLLM()          ← 调用 LLM
         ├─ 执行 tool_use 工具  ← 阻塞、串行
         └─ (end_turn) 返回文本
```

关键特点：
- `sessionMessages`（第 190 行）是**模块级单例**，所有对话共享一份消息数组。
- `runAgent` 一次只处理一轮用户输入，返回后主 CLI 再等下一轮。
- **没有**子任务、并发调度、任务回收的概念。

### 1.2 原 Claude Code 的多 Agent 已被删除（见 STRIPPED.md）

| 被删模块 | 功能 | 现状 |
|----------|------|------|
| `src/coordinator/` | 多 Agent 协调器 | 无 |
| `SendMessageTool/` | Agent 间消息通信 | 无 |
| `TeamCreateTool/` / `TeamDeleteTool/` | 团队管理 | 无 |
| `TaskCreateTool/` / `TaskListTool/` / `TaskUpdateTool/` | 任务管理 | 计划保留但未实现 |

### 1.3 备份里的可复用参考

`Plan/Backup/src-utils/` 保留了原架构的**关键骨架**，可作设计参考（**不能直接照搬**，依赖已删除模块）：

- `forkedAgent.ts` — `runForkedAgent()` 子 Agent 循环、`createSubagentContext()` 上下文隔离
- `task/framework.ts` — 任务注册/轮询/输出 delta/通知
- `Task.ts` — Task 类型（含 `local_agent` 任务类型）
- `model/agent.ts` — 子 Agent **模型继承**逻辑（`inherit` 语义）

---

## 二、方案选型（两种）

### 方案 A：并行 Fork（推荐首发）

**核心思想**：把主 Agent 的任务拆成多个**相互独立**的子任务，用并发调度器**同时**跑多个 `runAgent` 实例，等全部完成后汇总。

**适用场景**：
- 拆分独立子任务（"同时审查这 3 个文件"、"并行搜索 2 个主题"）
- 多个互不依赖的独立子问题

**改动量**：中等。不改对外接口，新增一个可复用子 Agent 函数 + 一个并发调度器。

---

### 方案 B：Task 工具体系（进阶）

**核心思想**：仿照 Claude Code 原架构，新增 `TaskCreateTool / TaskListTool / TaskUpdateTool`。父 Agent 通过工具**派发任务**，子任务**异步**在后台跑，父 Agent 稍后**轮询回收**结果。

**适用场景**：长任务、任务间有依赖、需要后台跑完再汇总。

**改动量**：大。需要磁盘输出文件、poll 循环、任务状态机、通知机制。

> **建议**：先落地方案 A，跑通后如有需要，再在 A 的基础上演进到 B。

---

## 三、方案 A 详细设计

### 3.1 目录 / 文件规划

```
src/
 └─ agents/
     ├─ runSubAgent.ts      ← 可复用的子 Agent 执行函数（核心）
     ├─ dispatch.ts         ← 并发调度器（Promise.all + p-map）
     ├─ SubAgentResult.ts   ← 结果类型
     └─ prompt.ts           ← 子 Agent 专用 system prompt 构建
 参考：
 Plan/Backup/src-utils/forkedAgent.ts   ← 原版设计参考
```

### 3.2 核心：`runSubAgent.ts`

当前 `runAgent` 用**模块级单例**（`sessionMessages`、`SYSTEM_PROMPT`、`toolContext`），无法并行。需重构为**实例化、可隔离**的版本。

**新签名**：

```ts
export interface SubAgentParams {
  // 核心：传入本子任务的专属 prompt 与初始上下文
  userPrompt: string;
  systemPrompt: string;        // 子 Agent 专属 system prompt
  parentContext: ToolUseContext; // 父上下文（用于继承 options/tools）

  // 隔离控制（关键！保证并行安全）
  messages?: ChatMessage[];    // 默认空数组，每子任务独立
  abortController?: AbortController; // 默认新建，父取消时可级联
}

export interface SubAgentResult {
  text: string;          // 子 Agent 最终输出文本
  messages: ChatMessage[]; // 子 Agent 全程消息（可回收）
  durationMs: number;
  turns: number;         // 用了多少轮
}
```

**关键改造点**（相对当前 `runAgent`）：

| 当前代码 | 改造为 |
|----------|--------|
| 模块级 `sessionMessages` | 函数内局部 `messages` 数组 |
| 模块级 `SYSTEM_PROMPT` | 参数传入 `systemPrompt` |
| 模块级 `toolContext` | 由 `parentContext` 派生，或传入 |
| 无隔离 | 每子任务一个 `AbortController` |
| `callLLM` 依赖全局 `MODEL/PROVIDER` | 参数可覆盖子模型（方案 B 用） |

**参考**：原 `forkedAgent.ts` 的 `createSubagentContext()` 提供了「隔离可变状态、继承 options」的思想，我们的 `runSubAgent` 只需取其最小子集。

---

### 3.3 结果类型 `SubAgentResult.ts`

```ts
export type SubAgentResult = {
  key: string;           // 子任务标识（如 "file1"）
  text: string;
  durationMs: number;
  turns: number;
  error?: string;        // 失败时填充
};
```

---

### 3.4 并发调度器 `dispatch.ts`

用现成依赖 `p-map@7.0.6`（package.json 已有），**限制并发数**避免打爆 API。

```ts
import pMap from 'p-map';
import { runSubAgent } from './runSubAgent.js';
import type { SubAgentParams, SubAgentResult } from './SubAgentResult.js';

interface DispatchItem {
  key: string;
  params: Omit<SubAgentParams, 'messages'>;
}

export async function dispatchTasks(
  items: DispatchItem[],
  options: { concurrency?: number } = {},
): Promise<SubAgentResult[]> {
  const concurrency = options.concurrency ?? Math.min(items.length, 3);

  return pMap(
    items,
    async (item) => {
      const start = Date.now();
      try {
        const result = await runSubAgent({
          ...item.params,
          messages: [],   // 每子任务独立上下文
        });
        return {
          key: item.key,
          text: result.text,
          turns: result.turns,
          durationMs: Date.now() - start,
        };
      } catch (e) {
        return { key: item.key, text: '', turns: 0, durationMs: Date.now() - start, error: (e as Error).message };
      }
    },
    { concurrency },  // p-map 的并发控制
  );
}
```

**并发数建议**：
- 默认 `min(items.length, 3)`，避免超出 API 限流。
- 可通过环境变量 `MYCODER_CONCURRENCY` 覆盖。

---

### 3.5 子 Agent 的 system prompt（`prompt.ts`）

复用 `buildSystemPrompt()` 的规则，但追加子 Agent 专属指令：

```ts
export function buildSubAgentSystemPrompt(subTask: string): string {
  return [
    `You are a worker subagent in my-coder.`,
    `Your focused task: ${subTask}`,
    ``,
    `## Rules for subagents`,
    `- Complete ONLY your assigned task; do not start unrelated work.`,
    `- Do not call multi-agent / task-dispatch tools (avoid recursion).`,
    `- Return a concise final summary of what you did and found.`,
  ].join('\n');
}
```

---

### 3.6 入口集成（`src/main.ts` 改造）

在工具系统中新增一个 `DispatchTool`（或先做**平铺的 3 个独立子 Agent** 命令），两种用法可选：

**用法 1：环境变量方式（最简单，首选验证）**
```bash
MYCODER_TASKS="审查 a.ts,审查 b.ts,审查 c.ts" npm start
```
启动时解析任务列表 → `dispatchTasks()` 并行跑 → 汇总打印。

**用法 2：工具方式（进阶，加入 tools-v2）**
- 在 `tools-v2/` 下新增 `DispatchTool/`，主 Agent 通过工具传任务数组，返回汇总结果。
- 需要把子任务集合作为 `tool_use` 结果返回主循环。

---

## 四、方案 B 概要设计（进阶预留）

### 4.1 任务状态机

```
pending → running → completed
               ↘ failed
                  killed
```

### 4.2 新增 Tool

| Tool | 职责 |
|------|------|
| `TaskCreateTool` | 创建任务，异步 fork 子 Agent，返回 taskId |
| `TaskListTool` | 列出全部任务及状态 |
| `TaskUpdateTool` | 修改/取消任务、读取输出 |

### 4.3 磁盘输出

- 每个任务一个输出文件：`<tmp>/tasks/<taskId>.out`
- `diskOutput.ts`（Backup 已保留）管理增量读取
- 父 Agent 用 `TaskListTool` 轮询状态、用 `TaskUpdateTool` 拉取 delta

---

## 五、实施步骤（方案 A，按顺序）

1. **创建 `src/agents/` 目录**
   - 先写 `SubAgentResult.ts`（纯类型，无依赖）。

2. **重构 `runAgent` 为 `runSubAgent`**
   - 从 `main.ts` 抽出循环体，把 `sessionMessages/SYSTEM_PROMPT/toolContext` 参数化。
   - 保持 `main.ts` 的 `runAgent` 作为薄封装（内部调 `runSubAgent`），**不改对外 CLi 行为**。

3. **写 `dispatch.ts`**
   - 引入 `p-map`，实现并发调度 + 结果汇总。

4. **写 `prompt.ts`**
   - 子 Agent 专用 system prompt。

5. **接通 `main.ts`**
   - 先做「环境变量任务列表」入口，快速验证 3 个子 Agent 并发跑。
   - 验证 API 限流（并发 3 是否安全）。

6. **构建 + 端到端测试**
   - `npm run build` 通过。
   - 需要真实 API key 验证多 Agent 实际跑通。

7. **（可选）演进到方案 B**
   - 在 A 基础上新增 `DispatchTool`，最终做成 `TaskCreate/List/Update`。

---

## 六、风险与注意事项

| 风险 | 对策 |
|------|------|
| **API 限流**：并发请求触发 429 | 默认并发 3，环境变量可调；`p-map` 控流 |
| **上下文隔离不彻底**导致数据串扰 | 每子任务独立 `messages` 数组 + 独立 `AbortController` |
| **子 Agent 误调递归工具**（如又派生子任务） | system prompt 明确禁止 + DispatchTool 调用深度限制 |
| **原 Backup 代码不可直接复用**（依赖 AppState/query/analytics） | 只参考设计思想，自己实现最小版本 |
| **共享文件竞争**：两个子 Agent 同时改同一文件 | 方案 A 首选只读/独立子任务；写场景需任务级锁（暂不支持） |
| **成本**：多 Agent 并行 token 消耗成倍 | 限制并发 + 子 Agent 用更短/精简 prompt |

---

## 七、验收标准

- [ ] `npm run build` 零错误
- [ ] 启动时能并发执行 ≥2 个子 Agent（实际调用 API）
- [ ] 各子 Agent 上下文完全隔离，结果互不污染
- [ ] 并发数可配置（默认 3）
- [ ] 汇总输出清晰标注每个子任务的结果
- [ ] 失败的子任务能单独标记 `error`，不影响其他成功任务

---

## 附：现状关键代码位置（main.ts）

| 符号 | 行号 | 说明 |
|------|------|------|
| `sessionMessages` | 190 | 模块级单例，需参数化 |
| `runAgent()` | 192 | 主 Agent 循环，需抽出可复用 |
| `callLLM` | 137 | LLM 调用，依赖全局 MODEL/PROVIDER |
| `toolContext` | 63 | 工具上下文 |
| `SYSTEM_PROMPT` | 181 | 全局 prompt |
| `buildSystemPrompt()` | 142 | 主 prompt 构建 |
