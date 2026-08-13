# 执行计划 — WorkTree 作为独立思考单元

## 一、改动文件

| 文件 | 改动 | 行数 |
|------|------|------|
| `src/work_tree/thinker.ts` | **新建** — thinkWorkTree() 函数 | ~80 |
| `src/work_tree/orchestrator.ts` | **新建** — runTreeExecution() 编排 | ~60 |
| `src/session_loop.ts` | 修改 — for 循环之前插阶段 1，加 isMainAgent 判断 | +30 |
| `src/agent_def.ts` | 修改 — 新增 buildSystemPrompt('worktree') | +10 |
| **合计** | | **~180 行** |

---

## 二、Phase A: thinker.ts（1 Agent）

### 做什么

写一个纯函数 `thinkWorkTree(engine, messages): Promise<TaskTree | null>`。

不调 executeTools。只调 callLLM。专用 systemPrompt："你只分析意图和语义分解。不执行任何工具。输出结构化 JSON。"

### 具体步骤

```typescript
// src/work_tree/thinker.ts

export async function thinkWorkTree(
  engine: AgentEngine,
  userMessage: string
): Promise<TaskTree | null> {
  // 1. 构建轻量上下文（只传用户消息，不传完整历史）
  const messages = [{ role: 'user', content: userMessage }];

  // 2. 切 systemPrompt 为 worktree 专用版
  const originalPrompt = (engine as any).systemPrompt;
  (engine as any).systemPrompt = engine.buildSystemPrompt?.('worktree') || originalPrompt;

  try {
    // 3. 跑 5 轮 LLM 循环（不调 executeTools）
    for (let i = 0; i < 5; i++) {
      const response = await (engine as any).callLLM(messages, 'thinking task tree');

      if (response.stop_reason === 'end_turn') {
        // 解析 LLM 输出的 TaskDecomposition JSON
        const text = extractText(response);
        const decomposition = parseDecomposition(text);
        if (decomposition) {
          const { createTree, addChildNode } = await import('../task_tree/core.js');
          const { saveTree } = await import('../task_tree/persist.js');
          const tree = createTree(`tree-${Date.now().toString(36)}`, decomposition.purpose);
          for (const g of decomposition.groups) {
            addChildNode(tree, tree.rootId, {
              meaning: g.meaning,
              task: g.meaning,
              role: g.isLeaf ? 'worker' : 'supervisor',
            });
          }
          saveTree(tree);
          return tree;
        }
        return null; // 无法解析 → 降级，交给主 Agent 自己处理
      }

      // tool_use → 忽略（thinker 不应该调工具，但如果 LLM 调了，push 空结果继续）
      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: '(no tool available — focus on decomposition)' });
      }
    }
    return null;
  } finally {
    (engine as any).systemPrompt = originalPrompt; // 恢复
  }
}
```

### 关键依赖

- `engine.callLLM()` — 已有
- `engine.buildSystemPrompt('worktree')` — Phase D 补充
- `parseDecomposition()` — 从 LLM 文本中提取 JSON，容错解析

---

## 三、Phase B: orchestrator.ts（1 Agent）

### 做什么

`runTreeExecution(engine, tree, messages): Promise<LoopResult>`。

主 Agent 拿到树之后，这个函数读树的 `getExecutableLeaves`，对每个叶子调 `AgentTool` 派 Worker，用 `AgentTeam wait` 等全部完成，收结果汇总。

### 具体步骤

```typescript
// src/work_tree/orchestrator.ts

export async function runTreeExecution(
  engine: AgentEngine,
  tree: TaskTree,
  baseMessages: ChatMessage[],
  onProgress?: (e: ProgressEvent) => void,
): Promise<LoopResult> {
  // 1. 注入树到 messages
  const { renderTree } = await import('../task_tree/core.js');
  baseMessages.push({
    role: 'user',
    content: `[WORKTREE]\n${renderTree(tree)}\n\n按此树执行，并行派发独立义群，串行依赖义群按顺序执行。`,
  });

  // 2. 复用现有 agentLoop——主 Agent 看到树后自己决定怎么 dispatch
  //    不需要自己重写循环逻辑。agentLoop 已经被 cluster 模式适配好了。
  //    关键是 messages 里已经包含了树信息 + 执行指令。
  
  // ★ 实际上 orchestrator 就是现有 agentLoop。
  //    区别只是 messages 里多了一条 [WORKTREE] 前缀的消息。
  //    主 Agent 的 systemPrompt 已经告诉它"看到 [WORKTREE] 就按树执行"。
  
  // 所以 orchestrator.ts 极简——可能只有 20 行。核心是 "把树注入 messages，
  // 然后继续跑 agentLoop"。
  
  return null; // Placeholder — 实际复用 agentLoop
}
```

### 关键发现

orchestrator 不需要自己实现循环。**messages 注入树文本 + 主 Agent 的 systemPrompt 规则** 就足够了。这和当前 LLM 调 TreeCmd 然后自己派 Agent 的行为完全一样——只是树现在是**必定存在**的，不是 LLM 可选创建的。

---

## 四、Phase C: session_loop 集成（1 Agent）

### 改动位置

`src/session_loop.ts` — `agentLoop` 函数，`for` 循环之前（约第 117 行）。

### 具体代码

```typescript
export async function agentLoop(
  engine: AgentEngine,
  params: AgentLoopParams,
): Promise<LoopResult> {
  const { messages, maxRounds, ... } = params;

  // ━━━━━━━━━ 阶段 1: WorkTree 思考 ━━━━━━━━━
  if (params.isMainAgent && messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'user') {
      try {
        const { thinkWorkTree } = await import('./work_tree/thinker.js');
        const userText = typeof lastMsg.content === 'string' 
          ? lastMsg.content 
          : (lastMsg.content as any[]).filter(c => c.type === 'text').map(c => c.text).join('\n');
        const tree = await thinkWorkTree(engine, userText);
        if (tree) {
          engine.setActiveTree(tree.sessionId);
          const { renderTree } = await import('./task_tree/core.js');
          messages.push({
            role: 'user',
            content: `[WORKTREE]\n${renderTree(tree)}\n\n按此任务树执行。独立分支并行派发，依赖分支串行执行。`
          });
        }
      } catch { /* thinker 不可用 → 降级到现有行为 */ }
    }
  }

  // ━━━━━━━━━ 阶段 2: 现有循环 ━━━━━━━━━
  for (let i = 0; i < maxRounds; i++) {
    // ... 完全不变
  }
}
```

### AgentLoopParams 扩展

```typescript
export interface AgentLoopParams {
  // ... 现有字段
  isMainAgent?: boolean;  // ★ 新增：true=主 Agent（走 WorkTree 阶段），false=子 Agent
}
```

### 调用方适配

- `cli.ts`: 传 `isMainAgent: true`
- `AgentTool.ts`: 不传（默认 false）——子 Agent 不走阶段 1

---

## 五、Phase D: prompt 适配

### agent_def.ts 改动

```typescript
case 'worktree':
  return [
    `## 语义分解`,
    `- 你只做一件事：分析用户意图，按语义拆分为独立义群。`,
    `- 不执行工具。不回复用户。只输出结构化 JSON。`,
    `- 简单任务（"你好"）→ 1 个叶节点`,
    `- 复杂任务 → 多个义群，标记 isLeaf 和可并行性`,
    `- 输出格式：`,
    `  {`,
    `    "purpose": "一句话描述",`,
    `    "groups": [`,
    `      { "meaning": "义群描述", "isLeaf": true/false }`,
    `    ]`,
    `  }`,
  ];
```

---

## 六、Agent 布局

```
Phase A (thinker.ts)  ← 独立
Phase B (orchestrator.ts) ← 独立（可和 A 并行）
Phase C (session_loop 集成) ← 依赖 A 完成（需要 thinkWorkTree 函数签名确定）
Phase D (prompt) ← 可与 C 同时
```

---

## 七、验收

- [ ] `tsc --noEmit` 零错误
- [ ] "你好" → thinker 返回单节点树 → 主 Agent 直接回复，不派子 Agent
- [ ] "调查六领域" → thinker 返回 6 节点树 → 主 Agent 并行派 6 Worker
- [ ] 子 Agent（AgentTool 触发）→ isMainAgent=false → 跳过阶段 1
- [ ] thinker 返回 null → 降级到现有行为（LLM 自己决定）
- [ ] thinker 崩溃 → catch → 降级，不影响主流程
