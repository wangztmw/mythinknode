# Phase 52：LLM 并发控制

> **创建时间**：2026-08-03
> **状态**：规划中
> **涉及文件**：`src/llm/concurrency.ts`（新增）、`src/agent.ts`、`src/config.ts`

---

## 一、做什么

用一个 FIFO 信号量限制同时发起的 LLM API 请求数。主 Agent + 所有子 Agent 共享同一个计数器，超过上限的请求排队等待，而不是同时轰炸 API 然后吃 429。

## 二、方案

### 2.1 信号量实现

```typescript
// src/llm/concurrency.ts（新文件 ~35 行）
export class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return; }
    return new Promise(r => { this.queue.push(r); });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) { this.running++; next(); }
    else this.running = Math.max(0, this.running);
  }
}
```

### 2.2 Agent 接入

```typescript
// agent.ts
import { ConcurrencyLimiter } from './llm/concurrency.js';

export class AgentEngine {
  private llmLimiter = new ConcurrencyLimiter(3); // 默认 3

  private async callLLM(...): Promise<...> {
    await this.llmLimiter.acquire();  // 排队
    try {
      // ... 原有 LLM 调用
    } finally {
      this.llmLimiter.release();      // 必须释放
    }
  }
}
```

### 2.3 可配置

```typescript
// config.ts
const llmMaxConcurrency = fileConfig.llmMaxConcurrency ?? 3;
```

`~/.mycoder.json`：
```json
{ "llmMaxConcurrency": 2 }
```

### 2.4 超时保护

```typescript
async acquire(): Promise<void> {
  const deadline = Date.now() + 120_000; // 2 分钟硬超时
  if (this.running < this.max) { this.running++; return; }
  return new Promise((resolve, reject) => {
    const ticket = { resolve, deadline };
    this.queue.push(ticket);
    // 每 5 秒检查一次是否超时
    const check = setInterval(() => {
      if (Date.now() > ticket.deadline) {
        const idx = this.queue.indexOf(ticket);
        if (idx >= 0) this.queue.splice(idx, 1);
        clearInterval(check);
        reject(new Error('LLM concurrency queue timeout (120s)'));
      }
    }, 5000);
    // Promise resolved → clearInterval 在 resolve 被调用后自动无效
  });
}
```

## 三、改进点（效果）

| 之前 | 之后 |
|------|------|
| 5 个 Agent 同时调 → 5 路并发 → 2 路 429 → 全部重试 → 更慢 | 5 个 Agent → 3 个跑 + 2 个排队 → 零 429 → 实际更快 |
| 主Agent 也在抢，子Agent 也在抢 | 统一排队，先到先服务 |
| 换 API 要改代码 | 配置文件一行改 |
| 排队永久阻塞 | 120s 超时自动放弃，抛异常由 callLLM 处理 |

## 四、隐患与缓解

| 隐患 | 严重度 | 缓解 |
|------|--------|------|
| **队列饿死**：某个子Agent 内部死循环（一直 tool_use 不 end_turn），永远不 release，后续请求饿死 | 🟡 中 | 子Agent 硬上限 10 轮 + Phase 54 的 5 分钟超时。两个兜底确保槽位最终释放 |
| **死锁**：主Agent 在排队，但它持有的某个资源被正在运行的子Agent 需要 | 🟢 低 | Mycoder 是单进程事件循环，callLLM 是 async/await，不持有锁。排队只影响 LLM 调用，不影响工具执行。不可能死锁 |
| **120s 超时太短**：复杂任务单次 LLM 调用可能超 2 分钟 | 🟢 低 | 当前 DeepSeek 单次调用很少超 60s。120s 是安全边际。可配置 |
| **多进程不共享信号量** | 🟢 低 | Mycoder 是单进程，不存在多进程场景 |
| **finally 不执行**（进程被 SIGKILL） | 🟢 极低 | SIGKILL 意味着整个进程没了，无所谓槽位释放 |

## 五、代价

- 高峰期多个子Agent 排队多等几秒（排队时间）。但比全部 429 重试好
- 新增 1 个文件 35 行
- agent.ts 每次 callLLM 前后各一行

## 六、文件变化

`src/llm/concurrency.ts`：新文件 +35 行
`src/agent.ts`：callLLM 前后各一行 +5 行
`src/config.ts`：读配置 +3 行

**总计**：+43 行，1 个新文件。
