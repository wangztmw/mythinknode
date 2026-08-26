# Phase 53：上下文注入 + 通知系统 + 创建逻辑统一

> **创建时间**：2026-08-03
> **状态**：规划中
> **严重程度**：🟡 严重
> **涉及文件**：`src/agent.ts`、`src/tools-v2/AgentTool/AgentTool.ts`、`src/task.ts`、`src/Mycoder.ts`

---

## 问题总览

本 Phase 合并三个独立但互有关联的中等问题：

| 问题 | 一句话 | 影响 |
|------|--------|------|
| P1 | AgentTool 绕过 createTask，ID 前缀不一致 + 逻辑重复 | 以后加字段需改两处 |
| P2 | 子 Agent 上下文极简，不知道主 Agent 在做什么 | 子 Agent 重复探索、无法关联大局 |
| P4 | 完成通知截断（1000字符）+ 同时完成堆积（3 条 → 上下文膨胀） | 主 Agent 丢失完整信息 |

三个问题都集中在 AgentTool 创建子 Agent 和子 Agent 完成后通知主 Agent 的这条链路里。一起修，一次编译验证。

---

## 一、P1：AgentTool 绕过 task.ts 创建逻辑

### 代码对比

**AgentTool.ts 手动构造**（第 48-53 行）：
```typescript
_tasks.set(id, {
  id, type: 'local_agent', status: 'running', subject: description,
  startTime: Date.now(),
  agentLoop: { roundCount: 0, toolUseCount: 0 },
  abortController: new AbortController(),
});
```

**task.ts createTask**（第 27-33 行）：
```typescript
export function createTask(type, subject, desc?) {
  const id = type[0] + Math.random().toString(36).slice(2, 10);
  const task = { id, type, status: 'running', subject, description: desc, startTime };
  if (type === 'local_agent') task.agentLoop = { ... };
  taskRegistry.set(id, task);
  return task;
}
```

### 三个不一致

| 问题 | AgentTool | task.ts | 后果 |
|------|-----------|---------|------|
| ID 前缀 | `'a' + random` → "a3kf8m2x" | `type[0] + random` → "l3kf8m2x" | registry 里两套命名 |
| 逻辑重复 | 手动 set + 构造字段 | 封装好的 createTask | 加新字段需改两处 |
| 缺字段 | 没传 description | createTask 有 desc 参数 | 子任务丢失 description |

### 修复

AgentTool 中调用 `createTask('local_agent', description, prompt.slice(0, 200))`，替换手动构造。同时 `createTask` 需扩展为接受 `parentId` 和 `depth`（来自 Phase 51）：

```typescript
// task.ts 扩展
export function createTask(
  type: 'local_agent' | 'local_bash',
  subject: string,
  desc?: string,
  parentId?: string,  // ← Phase 51 新增
  depth?: number,     // ← Phase 51 新增
): TaskState {
  const id = type[0] + Math.random().toString(36).slice(2, 10);
  const task: TaskState = {
    id, type, status: 'running', subject,
    description: desc,
    startTime: Date.now(),
    abortController: new AbortController(),
    parentId: parentId || null,
    depth: depth ?? 0,
  };
  if (type === 'local_agent') task.agentLoop = { roundCount: 0, toolUseCount: 0 };
  taskRegistry.set(id, task);
  return task;
}
```

**影响**：AgentTool.ts 减 6 行，task.ts 加 3 行参数。ID 前缀统一为 `'l'`。

---

## 二、P2：子 Agent 上下文极简

### 现状

```typescript
// AgentTool.ts buildSubAgentContext
(taskPrompt: string) => [
  { role: 'user', content: `Complete this task:\n${taskPrompt}\n\nReturn a concise report.` },
]
```

子 Agent 只有一条 user 消息，不知道主 Agent 在解决什么问题。

### 修复：分层上下文注入

**注入内容**：

```typescript
// Mycoder.ts 中重写 buildSubAgentContext
buildSubAgentContext: (taskPrompt: string) => {
  const context = engine.getSubAgentContext();
  return [{
    role: 'user',
    content: [
      `## Parent Agent Status`,
      `Working on: ${context.summary || '(just started)'}`,
      ...(context.siblings.length > 0 ? [`Other agents running: ${context.siblings.join(', ')}`] : []),
      `---`,
      `## Your Task`,
      taskPrompt,
      `---`,
      `Return a concise report. You are a sub-agent — do not ask questions.`,
    ].join('\n'),
  }];
},
```

**agent.ts 新增 `getSubAgentContext()` 方法**：

```typescript
getSubAgentContext(): { summary: string; siblings: string[] } {
  // 取主 Agent 最近 3 轮 assistant 消息摘要
  const recentMessages = this.sessionMessages.slice(-6);
  const summary = recentMessages
    .filter(m => m.role === 'assistant')
    .map(m => typeof m.content === 'string'
      ? m.content.slice(0, 200)
      : JSON.stringify(m.content).slice(0, 200))
    .join(' | ')
    || null;

  // 兄弟 Agent 进展
  const siblings = [...this.taskRegistry.values()]
    .filter(t => t.type === 'local_agent' && t.status === 'running')
    .map(t => `"${t.subject}"(r${t.agentLoop?.roundCount || '?'})`);

  return { summary: summary || '', siblings };
}
```

**注入量控制**：摘要最多 ~600 字符 + 兄弟列表 ~200 字符 ≈ 800 字符额外上下文，对 token 开销可忽略。

---

## 三、P4：完成通知被截断 + 堆积

### 问题一：1000 字符截断

**AgentTool.ts 第 60 行**：
```typescript
_notify!(... ${result.slice(0, 1000)});
```

子 Agent 生成 3000 字报告 → 主 Agent 只看到前 1000 字 → 完整内容需要主 Agent 主动 `Task(check)` → 主 Agent 经常忘记。

**修复**：提高预览到 1500，提示用户完整内容通过 Task(check) 获取：

```typescript
const MAX_PREVIEW = 1500;
const preview = result.length > MAX_PREVIEW
  ? result.slice(0, MAX_PREVIEW)
    + `\n\n... (${result.length - MAX_PREVIEW} more chars. Use Task(check, ${id}) to see full report.)`
  : result;
_notify!(`[Agent "${description}" completed...]:\n${preview}`);
```

### 问题二：同时完成通知堆积

3 个子 Agent 在 300ms 内先后完成 → 独立 notify → 3 条 pendingNotifications → 下一轮同时注入 → 上下文膨胀。

**修复**：通知合并窗口

```typescript
// AgentEngine 中
private notificationBuffer: string[] = [];
private notificationTimer: ReturnType<typeof setTimeout> | null = null;

notify(msg: string) {
  this.notificationBuffer.push(msg);
  if (this.notificationTimer) clearTimeout(this.notificationTimer);
  this.notificationTimer = setTimeout(() => {
    const merged = this.notificationBuffer.length > 1
      ? `${this.notificationBuffer.length} sub-agents completed:\n\n`
        + this.notificationBuffer.join('\n\n---\n\n')
      : this.notificationBuffer[0];
    this.pendingNotifications.push({ role: 'user', content: merged });
    this.notificationBuffer = [];
    this.notificationTimer = null;
  }, 500); // 500ms 合并窗口
}
```

---

## 四、改动清单

| 文件 | 改动 | 预计行数 |
|------|------|---------|
| `src/task.ts` | createTask 接受 parentId/depth 参数 | +4 |
| `src/tools-v2/AgentTool/AgentTool.ts` | 改用 createTask；提高通知预览上限 | +5/-8 |
| `src/agent.ts` | 新增 getSubAgentContext()；notify 改为合并窗口 | +20 |
| `src/Mycoder.ts` | buildSubAgentContext 注入主 Agent 上下文 | +8/-2 |

**总计**：+37/-10。

---

## 五、验证标准

| # | 场景 | 期望结果 |
|---|------|---------|
| 1 | 创建子 Agent 后检查 task.id | ID 前缀为 `'l'`（如 `'l3kf8m2x'`），而非 `'a'` |
| 2 | 子 Agent 收到的消息 | 包含 "Parent Agent Status" 和主 Agent 最近操作摘要 |
| 3 | 3 个子 Agent 300ms 内完成 | 主 Agent 收到 1 条合并通知（而非 3 条） |
| 4 | 子 Agent 报告超过 1500 字符 | 通知末尾提示 "Use Task(check, ...) for full report" |
| 5 | 编译 | npx tsc --noEmit 零错误 |
