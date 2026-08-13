/**
 * LLM 并发信号量 — 防止多 Agent 同时轰炸 API 触发 429
 *
 * 主 Agent + 所有子 Agent 共享同一个计数器。
 * 超出上限的请求排队（FIFO），等槽位释放后自动继续。
 * 120s 超时防止队列永久阻塞。
 */
export class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return; }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex(t => t.resolve === resolve);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new Error('LLM concurrency queue timeout (120s)'));
        }
      }, 120_000);
      this.queue.push({ resolve, timer });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      clearTimeout(next.timer);
      next.resolve();
    } else {
      this.running = Math.max(0, this.running);
    }
  }
}
