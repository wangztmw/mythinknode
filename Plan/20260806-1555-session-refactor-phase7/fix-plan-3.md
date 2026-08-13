# 修正计划（第三轮）— 从过程树到内容树

## 根因

当前 Thinker 的分解逻辑是**拆步骤**（先抓数据→再整理报告）。步骤之间有依赖，子 Agent 拿到的是"过程碎片"，没法独立完成完整工作。整棵树全 pending，主 Agent 自己干了 80%。

## 核心改动

**从"拆步骤"改为"拆内容领域"。**

```
改前（过程树）:                    改后（内容树）:

"搜索新闻并整理报告"               "今日新闻调查"
  ├─ curl抓数据 ← 过程步骤            ├─ AI领域调查 ← 内容领域
  ├─ 整理AI报告 ← 等数据              │   Worker: 产出完整AI日报
  └─ 整理绿电报告 ← 等数据            └─ 绿电领域调查 ← 内容领域
                                          Worker: 产出完整绿电日报

节点 full pending, 主Agent自己干      每个节点独立可交付, 主Agent只汇总
```

## 修改

### 修 1: Thinker prompt 重写 — 拆内容不拆步骤

**文件**: `agent_def.ts` — worktree prompt

改前:
```
你是 WorkTree 思考节点。只做一件事：分析用户意图，按语义拆分为独立义群。
```

改后:
```
你是 WorkTree 思考节点。只做一件事：把用户意图按内容领域拆分。

分解原则（重要）:
- 拆内容，不拆步骤。每个义群 = 一个完整的内容领域
- 每个叶节点必须能独立产出完整的交付物——Agent 认领后自决定怎么搜、怎么写
- 不要把"抓数据"和"整理报告"拆成两个节点——这是步骤，不是内容
- 例子:
  用户: "调查AI和绿电，各写一份报告"
  → 义群1: "AI领域调查"（产出完整AI日报）
  → 义群2: "绿电领域调查"（产出完整绿电日报）
  不要拆成: curl抓数据 / 整理AI / 整理绿电

- 如果用户任务只有一个内容领域 → 单节点树，不拆分
- 多个内容领域 → 每个一个叶节点，全部可并行
```

### 修 2: Agent prompt — 收到的是完整内容任务

**文件**: `agent_def.ts` — Worker prompt

当前:
```
你是叶节点 Worker。干一件具体的事→返回可直接使用的完整结果→销毁。
```

改为:
```
你是叶节点 Worker。你负责一个完整的内容领域。在这个领域内你有完全自主权——自己决定搜什么、怎么分析、怎么写。交付一个完整的、可直接使用的最终结果。不要返回半成品，不要依赖其他 Agent 的产出。
```

### 修 3: Planner prompt — 只做内容汇总，不干基础活

**文件**: `agent_def.ts` — Planner prompt

追加:
```
你的职责是内容编排，不是亲自执行。每个子Agent交付的是一份完整的内容报告——你只做汇总、比较、合成。不要自己搜数据、不要自己写报告。如果子Agent结果不满意，用更精确的 prompt 重新派发。
```

## 效果预期

```
用户: "调查AI和绿电，各写报告"

Thinker 产出:
  purpose: "今日AI和绿电领域调查"
  groups:
    - { meaning: "AI领域调查", isLeaf: true }
    - { meaning: "绿电领域调查", isLeaf: true }

主 Agent:
  Agent(description="AI调查", prompt="搜索今日AI新闻，分析动态，撰写完整日报")
  Agent(description="绿电调查", prompt="搜索今日绿电新闻，分析动态，撰写完整日报")

子 Agent A (AI调查):
  第1轮: WebSearch "AI news today" → 拿到10条
  第2轮: Read 3篇关键文章 → 提取要点
  第3轮: WebSearch "DeepSeek pricing August 2026" → 补充细节
  第4轮: Write AI领域日报_20260806.md
  第5轮: [DONE] 返回完整报告

主 Agent 收报告 → 汇总 → 交付用户
```

## 实施

| 修 | 文件 | 行数 |
|----|------|------|
| Thinker prompt 重写 | agent_def.ts worktree case | 改写 ~15 行 |
| Worker prompt 强化 | agent_def.ts worker case | +3 |
| Planner prompt 强化 | agent_def.ts planner case | +2 |
| **合计** | **agent_def.ts** | **~20 行** |

纯 prompt 层改动，零代码变更。
