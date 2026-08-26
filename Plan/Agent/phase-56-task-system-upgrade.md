# Phase 56：Task 系统升级

> **创建时间**：2026-08-03
> **状态**：规划中
> **学自**：Claude Code Task.ts 设计
> **涉及文件**：`src/task.ts`、`src/tools-v2/AgentTool/AgentTool.ts`、`src/tools-v2/BashTool/BashTool.ts`、`src/tools-v2/TaskTool/TaskTool.ts`

---

## 一、做什么

把 task.ts 从"内存纸条"升级成"磁盘账本"——三个核心能力：

1. **任务状态机**：加入 `pending` 缓冲态，创建→启动→完成有明确转换
2. **输出持久化**：子Agent/后台Bash 输出原子写入磁盘（tmp + rename），内存只存摘要
3. **通知去重 + 溯源**：`notified` 防重复通知，`toolUseId` 关联 LLM 调用

## 二、方案

### 2.1 TaskState 扩展

```typescript
export interface TaskState {
  id: string;
  type: 'local_agent' | 'local_bash';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
  subject: string;
  description?: string;
  startTime: number;
  endTime?: number;
  output?: string;           // 内存摘要（前 500 字）
  outputFile: string;        // 磁盘完整路径 (~/.mycoder/tasks/{id}.txt)
  outputOffset: number;      // 当前写入偏移量
  toolUseId?: string;        // 关联 LLM 工具调用
  notified: boolean;         // 完成通知是否已发
  abortController?: AbortController;
  agentLoop?: { ... };
  pendingInstruction?: string;
}
```

### 2.2 原子写入保障

```typescript
// src/task.ts 新增
function appendTaskOutput(id: string, text: string): void {
  const path = getTaskOutputPath(id);
  const tmp = path + '.tmp';
  // 先写临时文件，再原子 rename，防止写一半崩溃留下损坏文件
  writeFileSync(tmp, text);       // 注意：这里是覆盖写，每次写完整内容
  renameSync(tmp, path);
}

function readTaskOutput(id: string): string {
  const path = getTaskOutputPath(id);
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}
```

### 2.3 创建→执行状态转换

```typescript
// AgentTool.call() 中：
const task = createTask('local_agent', description); // status=pending
// ...稍后 runSubAgent 启动时:
task.status = 'running';
// 每轮循环结束后:
appendTaskOutput(task.id, currentOutput);
task.outputOffset = currentOutput.length;
// 完成后:
task.status = 'completed';
task.output = result.slice(0, 500); // 内存只存摘要
task.notified = false; // 等待 notify() 调用后置 true
```

### 2.4 文件清理

```typescript
// 启动时清理 7 天前的旧任务文件
function cleanOldTaskFiles(): void {
  const dir = join(homedir(), '.mycoder', 'tasks');
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
  }
}
```

## 三、改进点（效果）

| 改动 | 之前 | 之后 |
|------|------|------|
| `pending` 状态 | 创建即 running | 创建→启动间有缓冲，LLM 可先拿到 taskId 监控 |
| 磁盘输出 | output 全量存内存，崩了丢 | 原子写磁盘，崩了重启还能读 |
| `notified` | 可能重复通知 | 同任务只通知一次 |
| `toolUseId` | 不知道谁创建的任务 | 可追溯到 LLM 第几轮调用 |
| 文件清理 | 无 | 自动清 7 天前旧文件，不撑磁盘 |

## 四、隐患与缓解

| 隐患 | 严重度 | 缓解 |
|------|--------|------|
| **写磁盘失败**（磁盘满/权限） | 🟡 中 | 原子 tmp+rename 失败不污染现有文件。写入前检查剩余空间 < 10MB 时跳过写入，日志警告 |
| **内存内存输出与磁盘不一致** | 🟡 中 | 内存 output 只存摘要（前 500 字），完整内容以磁盘为准。读取时优先磁盘，内存作 fallback |
| **旧任务文件堆积** | 🟢 低 | 每次启动清理 7 天前文件 |
| **子Agent 中途崩溃，outputFile 不完整** | 🟡 中 | 原子写入保证已持久化的部分可读。崩溃后残留 pending/running 状态的任务文件在下次启动清理时保留（可能有用） |
| **大输出写磁盘阻塞 event loop** | 🟢 低 | `writeFileSync` 对 <100KB 内容通常 <1ms。如需优化，可改为 `writeFile` 异步写入 |

## 五、代价

- 每次 Agent 完成后一次 `writeFileSync`（~1ms），可忽略
- `~/.mycoder/tasks/` 目录占用少量磁盘（7 天自动清理）
- task.ts 从 47 行增到 ~70 行
- 代码复杂度从 CRUD Map 变成 Map + 文件 IO

## 六、文件变化

`src/task.ts` +23 行（字段+outputFile+清理）
`src/tools-v2/AgentTool/AgentTool.ts` +12 行（pending→running+写磁盘）
`src/tools-v2/BashTool/BashTool.ts` +8 行（同上）
`src/tools-v2/TaskTool/TaskTool.ts` +10 行（check读磁盘）

**总计**：+53 行，无新文件。
