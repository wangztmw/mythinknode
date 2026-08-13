/**
 * LLM API 重试策略
 *
 * 瞬态错误（网络抖动/服务端临时故障）→ 重试 10 次
 * 永久错误（DNS 失败/鉴权失败）→ 立即失败，给出明确提示
 * 退避加 jitter、retry-after 头、ECONNRESET→禁用 keep-alive、529 识别
 */

/** 判断是否值得重试 */
export function isRetryable(err: Error): boolean {
  const msg = err.message.toLowerCase();
  // 超时/中止/JSON残废 → 重试
  if (msg.includes('abort') || msg.includes('timeout') || msg.includes('unterminated')) return true;
  // 服务过载 → 重试
  if (msg.includes('529') || msg.includes('overloaded')) return true;
  // DNS/网络配置问题 → 重试没用
  if (msg.includes('enotfound')) return false;
  if (msg.includes('eai_again')) return false;
  // 鉴权/请求错误 → 重试没用
  if (msg.includes('401') || msg.includes('403')) return false;
  // 瞬态网络错误 + 服务端错误 → 重试
  return true;
}

/**
 * 带重试和超时的 fetch。
 * - 单次请求超时 120s
 * - 退避: 指数 + 25% jitter（防惊群）+ 优先 retry-after 头
 * - ECONNRESET → 下次重试 Connection: close（禁用 keep-alive 死连接）
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 10,
  perRequestTimeoutMs = 120_000,
  totalTimeoutMs = 600_000,
): Promise<Response> {
  const totalController = new AbortController();
  const totalTimer = setTimeout(() => totalController.abort(), totalTimeoutMs);

  let lastErr: Error | null = null;
  let hadEconnreset = false;

  try {
    for (let attempt = 0; attempt < retries; attempt++) {
      if (totalController.signal.aborted) {
        throw new Error(`Fetch aborted: total timeout (${totalTimeoutMs / 1000}s) exceeded`);
      }

      const reqController = new AbortController();
      const reqTimer = setTimeout(() => reqController.abort(), perRequestTimeoutMs);

      const onTotalAbort = () => reqController.abort();
      totalController.signal.addEventListener('abort', onTotalAbort, { once: true });

      // ECONNRESET 后禁用 keep-alive，避免复用死连接
      const headers = { ...(init.headers as Record<string, string> || {}) };
      if (hadEconnreset) headers['Connection'] = 'close';

      try {
        const r = await fetch(url, { ...init, headers, signal: reqController.signal });

        if ((r.status >= 500 || r.status === 429 || r.status === 529) && attempt < retries - 1) {
          lastErr = new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
          // 优先 retry-after 头（服务器最清楚该等多久）
          const retryAfter = r.headers.get('retry-after');
          const delay = retryAfter
            ? parseInt(retryAfter) * 1000
            : 1000 * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5); // 指数 + 25% jitter
          await new Promise(resolve => setTimeout(resolve, Math.min(delay, 60_000)));
          continue;
        }
        return r;
      } catch (e) {
        lastErr = e as Error;
        if (totalController.signal.aborted) throw lastErr;
        if (!isRetryable(e as Error) || attempt >= retries - 1) throw e;

        // ECONNRESET/EPIPE → 标记，下次重试走新连接
        const msg = (e as Error).message.toLowerCase();
        if (msg.includes('econnreset') || msg.includes('epipe')) hadEconnreset = true;

        // 指数退避 + 25% jitter，上限 30s
        const delay = Math.min(1000 * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5), 30_000);
        await new Promise(resolve => setTimeout(resolve, delay));
      } finally {
        clearTimeout(reqTimer);
        totalController.signal.removeEventListener('abort', onTotalAbort);
      }
    }
    throw lastErr || new Error('Request failed');
  } finally {
    clearTimeout(totalTimer);
  }
}
