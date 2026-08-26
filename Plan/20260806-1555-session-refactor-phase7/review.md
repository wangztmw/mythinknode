# Phase 7 审查报告 — Agent 集群并行审查

> 审查时间: 2026-08-06 | 2 Agent 并行: 缺陷分析 + 模块协调性

---

## 高危（必须修）

### R1: renderTree 不含 node ID → LLM 无法传 parent_node_id

LLM 从 [WORKTREE] 消息看到的树是纯文本（`├─ ○ 调查AI [pending]`），没有节点 ID。调用 Agent 时需要 `parent_node_id` 参数，但 LLM 不知道传什么。

**修复**: renderTree 输出加 ID，或 [WORKTREE] 消息中附加 ID 映射表。

### R2: _rolePrompt('worktree') 会运行时崩溃

`buildSystemPrompt('worktree')` 内部调 `_rolePrompt('worktree')`，但 switch 没有 'worktree' case → 返回 undefined → `...undefined` 展开 → TypeError。

**修复**: buildSystemPrompt 对 'worktree' 做 early return，不经过 `_rolePrompt`。同时修正 Phase 依赖标注——Phase A 依赖 Phase D，不能并行。

### R3: systemPrompt 全局切换有并发风险

thinkWorkTree 直接修改 `engine.systemPrompt`。如果上一轮的后台 Agent 还在跑，会读到错误的 worktree prompt。

**修复**: systemPrompt 改为 `callLLM` 的参数，不存为 engine 状态。

### R4: thinker 输入不统一——单条消息丢失多轮上下文

execution.md 只传最新一条消息，但 plan.md 说传"上下文摘要"。多轮对话中，thinker 只看到最后的追问，丢失前面的完整任务描述。

**修复**: 传入最近 3 轮 messages，而非仅最后一条。

---

## 中危（建议修）

### R5: orchestrator.ts 是死代码

Phase C 已经在 session_loop 中注入了 [WORKTREE] 并继续 for 循环，orchestrator 从未被调用。它的 60 行估计是假的——实际需要 0 行。

**修复**: 删除 orchestrator.ts 及 Phase B 任务。总代码量从 ~190 降到 ~130。

### R6: [WORKTREE] 注入后 LLM 可能重新建树

systemPrompt 第 132 行写着"复杂任务→先用 TreeCmd(create) 建工作树"。LLM 看到 [WORKTREE] 后可能再建一棵，而非使用 thinker 的树。

**修复**: systemPrompt 加规则："如果 messages 中已有 [WORKTREE] 前缀的树，直接使用，不要重复创建。"

### R7: callLLM 是 private

thinkWorkTree 必须用 `(engine as any).callLLM()` 绕过类型检查。

**修复**: 将 callLLM 改为 public，或新增 public 包装方法 `thinkCallLLM`。

### R8: "你好"延迟翻倍

简单问候从 1 轮 LLM 变成 2 轮（thinker + 主 Agent 各 1 轮）。延迟增加 100%。

**修复**: 加快速路径——`userText.length < 20` 且无任务关键词 → 跳过 WorkTree 阶段。

---

## 低危

- isMainAgent 逻辑正确（undefined=falsy），加注释即可
- thinker 崩溃有 catch 降级，安全；建议 catch 中加 console.warn
- orchestrator 删除后执行计划行数减少，不影响其他模块
