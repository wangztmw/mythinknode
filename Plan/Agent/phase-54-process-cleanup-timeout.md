# Phase 54：后台进程清理 + 子 Agent 超时兜底

> **创建时间**：2026-08-03
> **状态**：规划中
> **严重程度**：🟡 严重（P3）+ 🟢 中等（P5）
> **涉及文件**：`src/tools-v2/BashTool/BashTool.ts`、`src/Mycoder.ts`、`src/task.ts`、`src/agent.ts`

---

## 一、P3：detached 后台 Bash 子进程泄露

### 问题代码

**BashTool.ts 第 92-107 行**：
```typescript
if (run_in_background && _bgHooks) {
  const task = _bgHooks.createTask('local_bash', description || command.slice(0, 80));
  const child = spawn('sh', ['-c', command], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,  // ← 父进程退出 = 子进程继续运行
  });
  // stdout/stderr 收集...
  child.on('close', code => {
    _bgHooks!.completeTask(task.id, out);
    _bgHooks!.notify(...);
  });
}
```

### 与 Notion 经验总结的对应

你在「经验总结：进程泄露排查与 Phase 46 实战验证」中记录的：
- 系统 47 天未重启，9 个僵尸进程累积
- feishu MCP 运行 11 天吃掉 845 MB + 99.8% CPU
- npx/spawn 拉起的进程是独立进程，父进程退出后继续运行
- **核心教训**：npx 进程不会随终端关闭而退出

当前 BashTool 的 `detached: true` 是同一个陷阱——my-coder 崩溃或 Ctrl+C 退出后，后台子进程继续跑。

### 修复方案

#### 第一步：TaskState 记录子进程引用

```typescript
// task.ts
import type { ChildProcess } from 'node:child_process';

export interface TaskState {
  // ... 现有字段
  childProcess?: ChildProcess; // 后台 Bash 进程引用
}
```

#### 第二步：BashTool spawn 后保存引用

```typescript
// BashTool.ts — spawn 后追加一行
task.childProcess = child;
```

#### 第三步：进程退出时清理所有子进程

**改动文件**：`src/Mycoder.ts`，`main()` 函数内注册清理信号：

```typescript
// === 退出清理：kill 所有后台子进程 ===
function cleanupChildProcesses() {
  for (const [, task] of taskRegistry) {
    if (task.childProcess && task.status === 'running') {
      try {
        task.childProcess.kill('SIGTERM');
        // 等 2 秒后 SIGKILL
        setTimeout(() => {
          try { task.childProcess!.kill('SIGKILL'); } catch {}
        }, 2000);
      } catch {}
    }
  }
}

process.on('exit', cleanupChildProcesses);
process.on('SIGINT', () => { cleanupChildProcesses(); process.exit(0); });
process.on('SIGTERM', () => { cleanupChildProcesses(); process.exit(0); });
```

#### 第四步（可选）：去掉 detached: true

大多数场景下，后台 Bash 任务是会话的一部分，不需要在 my-coder 退出后继续运行：

```typescript
const child = spawn('sh', ['-c', command], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  // detached: true,   ← 删除
});
```

**但**：用户可能用 `run_in_background: true` 启动 dev server，Ctrl+C 后 server 突然死掉是坏体验。加一个显式标记：

```typescript
// inputSchema 新增
survive_exit: z.boolean().optional().describe(
  'Keep running after mycoder exits (for dev servers etc.). Default false.'
),
```

```typescript
// spawn 时条件判断
const spawnOpts: SpawnOptions = {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'] as const,
};
if (survive_exit) spawnOpts.detached = true; // 用户明确要求进程存活
```

默认 `survive_exit: false`（安全）。

---

## 二、P5：子 Agent 无 wall-clock 超时

### 问题

`runSubAgent()` 限制 10 轮迭代，但没有 wall-clock 超时。如果子 Agent 的工具调用 hang 住（WebFetch 120s timeout、Bash 死循环），10 轮可能拖到 20 分钟。

### 修复：Promise.race 整体超时

```typescript
const SUB_AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

async runSubAgent(taskPrompt: string, agentId: string): Promise<string> {
  const task = this.taskRegistry.get(agentId);
  if (task) task.status = 'running';

  const timeoutPromise = new Promise<string>((_, reject) => {
    setTimeout(() => reject(new Error('TIMEOUT')), SUB_AGENT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      this.runSubAgentLoop(taskPrompt, agentId, task), // 原循环逻辑抽为私有方法
      timeoutPromise,
    ]);
  } catch (e) {
    if ((e as Error).message === 'TIMEOUT') {
      if (task) { task.status = 'killed'; task.endTime = Date.now(); }
      return `(timeout after ${SUB_AGENT_TIMEOUT_MS / 60000}min)`;
    }
    return `(crashed: ${(e as Error).message})`;
  }
}
```

**设计选择**：`Promise.race`，而非在循环内检查时间。原因：
- 工具调用期间无法中断循环（js 是单线程事件循环，`execSync` 同步阻塞）
- `Promise.race` 在超时后立即 reject，即使工具还在 hang 住
- 超时后 task 标记为 killed，如果原循环最终返回，`check abort` 会在下次 LLM 调用前拦住
- 等价于"给整个子 Agent 设一个硬性截止时间"

### 超时值的考量

5 分钟 = 300 秒。子 Agent 典型耗时：
- 简单搜索 + 总结：30-60 秒
- 多文件修改 + 验证：2-4 分钟
- 复杂调研（多个 WebSearch + 交叉比对）：3-5 分钟

5 分钟能覆盖 95% 的合法场景。超出 5 分钟的通常是真的卡死了。

---

## 三、改动清单

| 文件 | 改动 | 预计行数 |
|------|------|---------|
| `src/task.ts` | TaskState 新增 childProcess 字段 | +2 |
| `src/tools-v2/BashTool/BashTool.ts` | spawn 后保存 childProcess；survive_exit 参数；去除默认 detached | +8/-2 |
| `src/Mycoder.ts` | 注册 SIGINT/SIGTERM/exit 清理回调 | +15 |
| `src/agent.ts` | runSubAgent 拆分为 runSubAgent + runSubAgentLoop；加 Promise.race 超时 | +20/-5 |

**总计**：+45/-7。

---

## 四、验证标准

| # | 场景 | 期望结果 |
|---|------|---------|
| 1 | Bash(run_in_background=true, survive_exit=false) 执行中 → Ctrl+C | 子进程被 SIGTERM → 2s 后 SIGKILL → `ps aux` 无残留 |
| 2 | Bash(run_in_background=true, survive_exit=true) 启动 dev server → Ctrl+C | 子进程继续运行 → `ps aux` 可见 |
| 3 | 子 Agent 内的 WebFetch hang 住 > 5 分钟 | timeout after 5min → task 标记 killed |
| 4 | 正常子 Agent（30 秒完成） | 不受超时影响 |
| 5 | 正常退出 `/exit` | 所有后台子进程被清理 |
| 6 | `ps aux | grep` 验证无僵尸进程 | 0 残留 |
