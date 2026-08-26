# 管道化 Agent 架构设计

> **创建时间**：2026-08-03
> **状态**：规划中

---

## 一、当前 MyCoder：内联模式

```
agent.run() {
  while 25轮:
    response = callLLM()               // LLM调用，在方法里
    if end_turn → return
    if tool_use:
      calls = Promise.all(调工具)        // 工具执行，在主循环里内联
      onProgress(显示)
      结果 → sessionMessages
      // 子Agent的处理也混在这里
}
```

**特点**：run() 知道一切细节——LLM 返回格式、工具怎么调、结果怎么格式化。逻辑揉在一起，调试要在一大段代码里跳。主 Agent 和子 Agent 的工具执行代码**重复了两遍**（run() L241-270 + runSubAgent() L317-344）。

---

## 二、管道模式

```
run() {
  while 25轮:
    ctx = thinkStage.execute(ctx)        // LLM环节：输入→思考
    if ctx.done → return
    ctx = actStage.execute(ctx)          // 工具环节：思考→行动
    ctx = orchestrateStage.execute(ctx)  // 编排环节：管理子Agent/通知
}
```

每个环节是**平等的黑盒**——接收公文包、处理、还给引擎。

### 公文包（AgentContext）

```typescript
interface AgentContext {
  messages: ChatMessage[];          // 对话历史
  pendingToolUses: ToolUse[];       // LLM返回的待执行工具
  pendingNotifications: Msg[];      // 子Agent发来的通知
  subAgents: TaskState[];           // 子Agent状态
  done: boolean;                    // 该停了吗
  lastResult?: string;              // 上一环节的输出摘要
}
```

### 三个环节

| 环节 | 输入 | 做什么 | 输出 |
|------|------|--------|------|
| **Think** | messages | 调 LLM，解析返回 | pendingToolUses / done / messages(含assistant回复) |
| **Act** | pendingToolUses | 找工具→并行执行→收集结果→显示 | messages(含tool_result) |
| **Orchestrate** | subAgents, notifications | 检查子Agent状态→收通知→决策是否继续 | done / updated subAgents |

---

## 三、与 Claude Code 管道的区别

Claude Code 的管道是**纵向安全管道**——每一层加深控制：

```
用户输入 → 权限检查 → 沙箱判断 → 工具执行 → 结果记录 → 界面渲染
```

Mycoder 的管道是**横向任务管道**——每一环推进任务：

```
用户输入 → LLM思考(Think) → 工具行动(Act) → 子Agent编排(Orchestrate) → 循环
```

Claude Code 管"安全"，Mycoder 管"组织"。方向不同。Mycoder 不需要 14 层安全管道，但需要一个清晰的**任务推进管道**让 LLM 能力被良好组织。

---

## 四、优劣

| 维度 | 内联(当前) | 管道(目标) |
|------|-----------|-----------|
| 可见性 | ✅ run() 里一览无余 | ❌ 要在 3 个 Stage 文件之间跳 |
| 可测试性 | ❌ 只能整个 run() 一起测 | ✅ 每个 Stage 独立测 |
| 可扩展性 | ❌ 改工具执行逻辑要动 run() | ✅ 只改 ActStage |
| 复用性 | ❌ run 和 runSubAgent 各写一遍 | ✅ 共用 Stage |
| 调试 | ✅ 打断点在 run() 里就行 | ❌ 打断点前要判断当前在哪个环节 |
| 代码量 | 350 行单文件 | ~200 行引擎 + 3×50 行 Stage = 350 行 |

总代码量差不多，但组织方式从"一个文件里一大段逻辑"变成"四个小文件 + 清晰边界"。

---

## 五、实施路线

### 第一步：最小抽离（已规划，明天实施）

把 `run()` 和 `runSubAgent()` 里重复的工具执行代码抽成 `executeToolCalls()`。不引入新文件，不引入 Stage 抽象。验证解耦的可行性。

### 第二步：Stage 化

把 `executeToolCalls()` 的思路扩展到 `callLLM()` 和 `orchestrate()`。三个方法变成三个独立的 Stage 类。

### 第三步：管道化

run() 从内联循环变成 Stage 调度循环。

每个阶段独立实施、独立验证。不一次性重构整个 agent.ts。

---

## 更新日志

| 日期 | 事件 |
|------|------|
| 2026-08-03 | 初始创建：管道架构设计讨论 |
