# Phase 57：推理预算管理 — 简单查询不要烧 token

> **创建时间**：2026-08-03
> **状态**：规划中
> **来源**：CoT 研究结论——e1/SR²AM/ALAR 等论文
> **涉及文件**：`src/agent.ts`

---

## 一、问题

当前 Mycoder 每轮 LLM 调用用相同的 `max_tokens: 4096`，不管任务是"你好"还是"梳理架构"。简单问候也分配 4096 token 预算，浪费时间。

## 二、从研究学到的

| 研究 | 关键发现 | 可用什么 |
|------|---------|---------|
| e1 (AWS) | 用相对预算替代绝对预算——"花 50% 精力" | `max_tokens` 动态调整 |
| SR²AM | 30B 模型打平 685B——靠聪明分配推理深度 | 非等比缩放 |
| ALAR | 搜索省 44% token，工具调用省 85% | 分类判断 |
| Overthinking Survey | 过度思考是已知问题，token 预算是最简解 | 按需分配 |

**核心结论**：不是所有请求需要同样多的思考。简单问候 ~100 token 够用，复杂任务才用满 4096。

## 三、实现

### 3.1 动态 max_tokens

```typescript
// agent.ts callLLM 中：
const TOKEN_BUDGETS = {
  greeting: 512,    // "你好" / "谢谢" — 极简
  command: 1024,    // 单步操作 — "看看目录" / "读这个文件"
  normal: 2048,     // 常规请求
  complex: 4096,    // 复杂任务 — "梳理架构" / "写一个完整的模块"
};

function classifyBudget(userInput: string, sessionLength: number): number {
  const len = userInput.length;
  if (len < 10 && sessionLength <= 2) return TOKEN_BUDGETS.greeting;  // 第一轮短消息
  if (len < 50) return TOKEN_BUDGETS.command;
  if (len < 200) return TOKEN_BUDGETS.normal;
  return TOKEN_BUDGETS.complex;
}
```

### 3.2 传递到 LLM 调用

```typescript
// openai.ts call() 中：
const effectiveMaxTokens = options?.maxTokens || 4096;
body: JSON.stringify({
  model,
  messages: apiMessages,
  max_tokens: effectiveMaxTokens,  // ← 动态
  tools,
  tool_choice: 'auto',
}),
```

**注意**：`max_tokens` 只控制回复长度，不影响 LLM 的"思考深度"。真正的 CoT 深度由系统提示词和 LLM 自身决定。但 shorter `max_tokens` = 简单回复不会拖长，确实能提速。

### 3.3 与子 Agent 的区别

子 Agent 永远是 `max_tokens: 2048`——子任务应该精简报告，不需要长篇推理。

---

## 四、改动清单

| 文件 | 改动 | 预计行数 |
|------|------|---------|
| `src/agent.ts` | 新增 `classifyBudget()` + callLLM 传 budget | +15 |
| `src/llm/types.ts` | LLMProvider.call 加 `maxTokens?` 参数 | +2 |
| `src/llm/openai.ts` | 使用传入的 maxTokens | +3 |
| `src/llm/anthropic.ts` | 同上 | +3 |

**总计**：+23 行。

---

## 五、验证

| # | 场景 | 期望 |
|---|------|------|
| 1 | "你好" 第一轮 | max_tokens=512，回复简短 |
| 2 | "梳理架构" | max_tokens=4096，回复完整 |
| 3 | 子Agent 任务 | max_tokens=2048，报告精简 |
| 4 | 第10轮对话后 | 即使短输入也用 normal（上下文已积累） |
