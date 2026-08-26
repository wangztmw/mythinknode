# 上下文窗口管理（Context Compression）计划

> **创建时间**：2026-08-02
> **状态**：规划中（待评审）
> **核心目标**：为 `sessionMessages` 无限增长的问题引入上下文窗口管理 / 压缩，避免长会话打爆模型上下文
> **核心文件**：`src/agent.ts`（主 Agent 与子 Agent 循环）、`src/llm/*.ts`

---

## 一、现状总结：上下文压缩在哪实现？

**重要结论：当前代码里没有真正的上下文压缩。** 我全量扫描了 `src/` 和 `Plan/`，确认：

### 1.1 现状：只有三个"隐性限制"，都不是压缩

| 机制 | 位置 | 作用 | 是否压缩 |
|------|------|------|---------|
| **主循环轮次上限** | `agent.ts` L133 `for (let i = 0; i < 25; i++)` | 最多 25 轮工具循环 | ❌ 不涉及 token |
| **子 Agent 轮次上限** | `agent.ts` L203 `for (let i = 0; i < 10; i++)` | 最多 10 轮 | ❌ 不涉及 token |
| **单次响应 max_tokens** | `llm/anthropic.ts`、`llm/openai.ts` `max_tokens: 4096` | 限制**单次生成** token | ❌ 不限制输入 |

### 1.2 真正的隐患

```
sessionMessages（主 Agent）
  ├── 每轮 user + assistant + tool_results 全部无限 push
  └── 跨轮对话持续累积，从不截断/压缩/归档

runSubAgent 的本地 messages（子 Agent）同样无限增长
```

**后果**：
- 长会话、多工具、大量文件读取后，`messages` 数组 token 数远超模型上下文窗口
- Anthropic 当前模型上下文通常 200K，OpenAI/DeepSeek 常见 64K~128K
- token 超限 → API 直接报 400 / context length exceeded 错误，**整个会话崩溃**
- 即便不崩，越长的输入成本越高、速度越慢

### 1.3 相关依赖现状

- `package.json` 依赖中**没有** tiktoken 或其他 token 计数库
- 也没有任何 LLM response 的长度检查、sizing 预估、截断逻辑

**一句话总结**：上下文压缩目前**不存在**，是缺失能力，不是已有能力。本计划要把这个能力补上。

---

## 二、为什么需要上下文压缩

| 触发场景 | 影响 |
|---------|------|
| 连续几轮读大文件 / 跑长 Bash | messages 迅速膨胀 |
| 超长会话跨多天 / 多主题 | 历史消息持续累积 |
| 并行工具输出合并后体积大 | 每题多 token |
| API 报 context length exceeded | **会话崩溃，前功尽弃** |

**价值**：
1. **防崩溃**——保证长会话不因超窗而挂
2. **控制成本**——token 付费模型下显著省钱
3. **提速**——短 prompt 推理更快
4. **一致性**——替代现在"25 轮硬顶就静默返回"的粗糙做法

---

## 三、目标架构

在 `agent.ts` 的 `callLLM()` 调用前，插入一段"上下文预处理"：先估算 token 数，超阈值则触发压缩/截断/归档。

```
src/
├── llm/
│   ├── types.ts            ← 扩展：消息尺寸标注
│   └── ...
├── context/                ← 新增目录
│   ├── counter.ts          ~60 行  Token 估算器（不做精确 tiktoken）
│   ├── policy.ts           ~80 行  压缩策略：截断/摘要/首尾保留
│   └── index.ts            ~30 行  applyContextPolicy(messages, apiModel)
└── agent.ts                ← 接入 callLLM / runSubAgent 前
```

### 3.1 核心：Token 估算器（counter.ts）

两个选型：

**方案 A：启发式估算（推荐先做，零依赖）**
```
字符数 ≈ 英文 4 chars/token，中文 1~1.5 chars/token
JSON 结构开销：每条消息 + base 开销
```
- **优点**：零依赖、快、可离线
- **缺点**：不精确，误差 ±30%
- **够用**：因为策略层是"阈值+缓冲"，不需要精确到个位

**方案 B：tiktoken（后续可选）**
- 安装 `tiktoken` npm 包（OpenAI 开源），按模型加载对应编码
- **优点**：精确
- **缺点**：加依赖、WASM 加载、模型不全是需要回退到启发式
- **定位**：启发式的降级与校验

**建议**：先做方案 A（启发式），为不同模型预留阈值配置；tiktoken 作为可选增强。

### 3.2 压缩策略（policy.ts）——三层递进

按 token 超限程度依次升级，优先保"最近上下文 + 关键系统信息"：

```
触发节点: token 估算 > modelWindow * safetyRatio (如 0.75)

Level 1 裁剪 —— 去掉只读的工具输出中超大块
  策略：对 FileRead/Glob/Grep/Bash 的输出做 token 预算截断
        （保留首尾+中间省略标记 "…[truncated N tokens]…"）
  影响：保留全部历史轮次，仅压缩单次大输出

Level 2 归档历史 —— 压缩"早于最近 N 轮"的消息
  策略：保留最近 K 轮完整消息（如最近 10 轮 tool_use block）
        更早的 user/assistant 文本合并为一条 "history summary"
  影响：大减 token，保留能对上的最近上下文

Level 3 摘要 —— 用 LLM 把早于窗口的历史压成概述
  策略：调用一次紧凑模型，把早于窗口的对话生成 summary token
        （可复用 provider.call，model 用快小模型）
  影响：最省 token，但丢失细节，且多一次 LLM 调用
  触发：仅 Level2 后仍超窗时
```

**关键原则**：
- **丢失风险由低到高**：先裁输出(L1) → 再归档(L2) → 最后摘要(L3)
- **系统提示永不压缩**——system prompt 是行为基础
- **最近 K 轮永不解压**——保证模型能对齐当前工具调用
- **压缩需产出"恢复信息"**（如 `…[earlier history summarized]…`），让模型知道有省略

### 3.3 策略配置（policy.ts / 配置）

```
.modelWindow  各模型上下文窗口（按 provider/model fallback 默认值）
.safetyRatio   占用窗口阈值（触发压缩），默认 0.75
.keepRecentRounds  保留最近完整轮数，默认 10
.maxOutputTokens  单条工具输出预算，默认 4096
.method        可选 auto|clip|archive|summarize
```

可用 `env`（如 `MYCODER_CONTEXT_LIMIT` / `MYCODER_MAX_OUTPUT_TOKENS`）覆盖。

---

## 四、接入点

### 4.1 主 Agent（`agent.ts` `callLLM`）

在把 `this.sessionMessages` 传给 `provider.call()` 前：
```ts
private async callLLM(messages: ChatMessage[], label?: string) {
  const prepared = applyContextPolicy(messages, this.model);  // ← 新增
  const result = await this.provider.call(
    this.systemPrompt, prepared, ...
  );
}
```

**注意**：
- `applyContextPolicy` 收到的是**副本**，不修改 `this.sessionMessages`——原数组用于持久化，仅调用时压缩视图
- 压缩结果需要能反馈给模型知晓（在压缩视图里插入省略标记消息）

### 4.2 子 Agent（`agent.ts` `runSubAgent`）

同样的控制点，子 Agent 本地 `messages` 在 `callLLM(messages)` 处应用同一策略。

### 4.3 Provider 层

`LLMProvider.call()` 目前签名固定，压缩在 agent 层完成即可，Provider 不动。若未来要精确 token 数，可在 `anthropic.ts`/`openai.ts` 的请求体加 `max_tokens` 及错误重试（收到 context length 错误时缩小窗口重试一次）。

---

## 五、分步实施计划

### Step 1：Token 估算器
- `src/context/counter.ts`，实现启发式估算 `estimateTokens(messages)` + 单消息估算
- 模型窗口表 `MODEL_WINDOWS`（anthropic claude-sonnet/opus、openai、deepseek 等）

### Step 2：裁剪策略（Level 1）
- `clipOversizedOutputs(messages, budget)`——压缩超大工具输出
- 为 `agent.ts` 的 `briefResult`/输出组装已有的 `.slice(0,1000)` 类逻辑做标准统一

### Step 3：归档策略（Level 2）
- `archiveHistory(messages, keepRecentRounds)`——保留最近 K 轮，早期合并为 history summary

### Step 4：摘要策略（Level 3，可选）
- `summarizeHistory()`，用 provider 调一次紧凑模型生成概述
- 需要向 AgentEngine 注入 provider/compact model

### Step 5：策略编排 + 接入 agent
- `applyContextPolicy()` 按"估算 → 选 Level → 压缩"编排
- 接入 `callLLM` 与 `runSubAgent`
- ⚠️ **接入前先打基线**：先只接 counter+log（不实际压缩），打印每轮 token 估算，确认阈值触发点正常

### Step 6：验证
- `npx tsc --noEmit` 零错误
- 构造长会话测试：大量 `FileRead` 大文件 → 确认 Level1 触发
- 更多轮次 → 确认 Level2 触发
- 确认 system prompt 与最近轮次始终保留
- 冒烟测试 `/help` + `/exit`

### Step 7：Config/Env 接入 + 文档
- 加 `MYCODER_CONTEXT_LIMIT` 等 env 覆盖
- 更新 `CORE_KEPT.md` 等文档

---

## 六、不做的事（边界）

| 不做 | 原因 |
|------|------|
| 一开始就接 tiktoken | 先用启发式，验证阈值有效性后再精化 |
| 精确 per-model token 表 | 用 fallback 默认值即可，精确留给 tiktoken 阶段 |
| 修改 Provider 消息格式 | 压缩在 agent 层完成，Provider 保持单一职责 |
| Level3 摘要默认开启 | 会多一次 LLM 调用，默认只开 L1/L2，L3 用 env 显式开关 |
| 改动 25 轮上限 | 那是节流不是压缩，两者独立，本次不动 |

---

## 七、风险

| 风险 | 缓解 |
|------|------|
| 压缩导致上下文断裂（模型"忘记"了） | 保留最近 K 轮 + 系统提示不压 + 插入省略标记让模型自知 |
| 启发式估算误差导致过早/过晚压缩 | safetyRatio 留缓冲(0.75)，先 baseline 观察 |
| 压缩后仍然超窗 | 从 L1 逐级到 L3 递进，L3 兜底 |
| 摘要(L3) 引入额外成本/延迟 | 默认关闭，仅显式开启 |
| 只读工具阶段变慢 | 估算开销极小（遍历一次），可忽略 |

---

## 八、结论

**上下文压缩目前完全缺失**——`sessionMessages` 无限累积是当前最真实的架构隐患，长期会话必爆 token。

建议**分阶段补齐**：
1. 先做**启发式 Token 估算 + 裁剪(L1) + 归档(L2)**（零/低依赖，立即可落地）
2. 验证阈值有效后，再考虑 **tiktoken 精确计数 + 摘要(L3)**
3. 全程**只压缩共享调用视图、不破坏持久化的 sessionMessages**，并严守"系统提示+最近轮次永不压缩"原则

这样既能解决崩溃风险，又为后续"多会话记忆/长期记忆"演进预留了统一出口（`context/` 目录）。
