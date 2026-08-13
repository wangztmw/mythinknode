# Tool Calling 2.0 / 程序化工具调用

> 资料时间：2026-08-07
> Anthropic Tool Calling 2.0 于 2026-02-18 GA，2026-05 Dynamic Workflows 发布

---

## 1. 原理模型

### 1.0（当前）：JSON 乒乓 —— 模型是胶水

```
User → LLM → { tool_use: "read_file", path: "a.ts" }
                ← { tool_result: "文件内容..." }
         → LLM → { tool_use: "read_file", path: "b.ts" }
                ← { tool_result: "文件内容..." }
         → LLM → "两个文件都读了，下面是分析..."
```

每个工具调用 = 一次 API 往返。模型逐次输出 JSON，系统执行，结果回流。模型的角色是一个"JSON 中转站"——把任务翻译成工具调用，把结果翻译成下一个工具调用。

**问题**：
- 每轮 tool_use 都要把中间结果塞进上下文 → 上下文窗口被大量中间数据占据
- N 步任务 = N 次推理 → 慢、贵
- 工具定义全量加载 → 100+ 个工具的定义可能吃掉 130K token

### 2.0：程序化编排 —— 模型是程序员

```
User → LLM → 写 Python 脚本:
                for region in ["us", "eu", "asia"]:
                  result = query_db(region=region)
                  print(f"{region}: {result}")
                print("=== Summary ===")
                (沙箱内执行，中间结果不回流上下文)
         → LLM → "三个区域查询完成，下面是汇总..."
```

模型**写代码**而不是**发 JSON**。一段脚本可以循环调用工具、用条件判断、声明变量。中间数据留在沙箱里。只有最终 stdout 到达模型。

---

## 2. 四大支柱

### 2.1 程序化工具调用（Programmatic Tool Calling）

**这是最核心的变革。**

工具定义里加 `allowed_callers`：

```json
{
  "name": "query_database",
  "input_schema": { ... },
  "allowed_callers": ["code_execution_20260120"]  // 只能在沙箱内调用
}
```

| allowed_callers 值 | 行为 |
|---|---|
| `["direct"]` | 传统 JSON 模式（默认） |
| `["code_execution_20260120"]` | 仅可通过沙箱代码调用 |
| `["direct", "code_execution_20260120"]` | 两种模式都行 |

**效果（Anthropic 实测）**：
- 输入 token ↓ 37%
- 总 token ↓ 24%
- Agentic 搜索基准（BrowseComp、DeepSearchQA）平均 ↑ 11%

### 2.2 懒加载 / 工具搜索（Tool Search）

全量加载 → 按需搜索。

```
传统：所有 200 个 MCP 工具定义都塞进 system prompt → ~130K token
2.0：模型看到工具名称列表，搜索相关工具，只加载前 5 个 → ~5K token
```

**效果**：
- 上下文占用 ↓ ~85%
- Opus 4.5 工具选择准确率：79.5% → 88.1%
- Opus 4 工具选择准确率：49% → 74%

环境变量：`ENABLE_TOOL_SEARCH = true | false | auto | auto:N`

### 2.3 input_examples

JSON Schema 只能描述参数**形状**，无法表达使用**惯例**。

```json
{
  "name": "search",
  "input_schema": { /* query: string, filters: object, ... */ },
  "input_examples": [
    {
      "description": "Simple keyword search — don't include filters",
      "input": { "query": "python async tutorial" }
    },
    {
      "description": "Filtered search — use filters for date/category",
      "input": { "query": "news", "filters": { "date": "2026-01-01", "category": "tech" } }
    }
  ]
}
```

**效果**：参数生成准确率 72% → 90%（+18 个百分点）。

注意：`input_examples` 和 `defer_loading` 互斥（不能同时用于同一工具）。

### 2.4 WebFetch 动态过滤

`web_fetch_20260209` 工具在返回网页内容前，先跑中间代码过滤原始 HTML/PDF → 去除非必需元数据 → token ↓ 24%。

---

## 3. Dynamic Workflows（Claude Code 专属，2026-05）

Claude Code 把程序化工具调用的思路推到了多 Agent 编排：

```
Claude Code 写 JavaScript 编排脚本:
  pipeline(items, stage1, stage2, ...)
  parallel(thunks)
  agent(prompt, { schema, agentType })
  phase("Review")
```

模型不是写 Python 调工具，而是写 JS **编排子 Agent**。每个子 Agent 有独立上下文窗口。母脚本只管调度。

**架构本质**：
- 一个 while-loop 实现 ReAct
- 决策逻辑只占代码库的 ~1.6%
- 其余全是对运行时基础设施的投入：权限、上下文压缩、安全护栏

---

## 4. 与 Claude Code 的对应关系

| 特性 | CC 现状 |
|---|---|
| 基础工具循环 | ReAct while-loop，模型逐个调工具 |
| 程序化工具调用 | 不在标准 CC 会话中。API 层有 `code_execution_20260120`，CC 的 Dynamic Workflows 是更高级的用法 |
| 工具搜索 / 懒加载 | **已启用**（`ENABLE_TOOL_SEARCH`），MCP 工具全量 defer |
| input_examples | MCP 工具定义中可用，CC 内建工具暂未使用 |
| 多 Agent 编排 | **Dynamic Workflows**（2026-05）：写 JS 编排 `agent()`、`pipeline()` 调用 |
| WebFetch 过滤 | **已启用**（`web_fetch_20260209` 工具） |
| 上下文压缩 | CC 专有：5 层压缩管线 |

---

## 5. 时间线

| 时间 | 事件 |
|------|------|
| 2022-10 | ReAct 论文 |
| 2023-06 | OpenAI function calling |
| 2023-11 | Anthropic tool use beta |
| 2024-05 | Anthropic tool use GA |
| 2024-11 | MCP 开源 |
| 2025-03 | OpenAI + Google 采纳 MCP |
| 2026-02-18 | Tool Calling 2.0 功能 GA |
| 2026-05-28 | CC Dynamic Workflows |
| 2026-03 | A2A v1.0 |

---

## 6. 关键区别一览

| | Traditional (1.0) | Tool Calling 2.0 |
|---|---|---|
| **执行模型** | JSON 乒乓，每步一次推理 | 程序化，模型写代码链式调 N 个工具 |
| **工具加载** | 全量（130K+ token） | 懒加载（~5K token） |
| **中间数据** | 全部回流上下文 | 留在沙箱 |
| **参数准确率** | Schema 单独指导 | + input_examples → 90% |
| **多 Agent** | 不原生支持 | Dynamic Workflows |
| **模型角色** | JSON 胶水 | 程序员，编排者 |

---

## 7. 参考资料

- [Anthropic Platform: Programmatic Tool Calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
- [Claude Code: Scale to Many Tools with Tool Search](https://code.claude.com/docs/en/agent-sdk/tool-search)
- [Dynamic Workflows in Claude Code (blog)](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)
- [PV-AI-Ops: Tool Calling 2.0 White Paper](https://pv-ai-ops.github.io/pv-knowledge-base/2026/03/12/White-Paper-Optimizing-LLM-Agent-Efficiency-with-Anthropics-Tool-Calling-20-Framework/)
- [BestHub: Tool Calling 2.0 Overview](https://www.besthub.dev/articles/tool-calling-2-0-autonomous-discovery-and-multi-agent-workflow-50aa8275dc0a)
- [LiteLLM: Anthropic Programmatic Tool Calling](https://docs.litellm.ai/docs/providers/anthropic_programmatic_tool_calling)
