# 修正计划（更新）

## 修正 1: WorkTree 思考阶段 CLI 无输出 ✅ 已修
## 修正 2: 子 Agent 完成通知未实时回流 ✅ 已修
## 修正 3: Thinking 0.0s 显示 ✅ 已修

---

## 修正 4: LLM API 调用稳健性增强（基于 Claude Code 调研）

### 对比差距

| 维度 | Claude Code | 我们 | 行动 |
|------|------------|------|------|
| 单次超时 | 300-600s | **18s** | → 改 120s |
| 退避 | 指数+25% jitter+retry-after头 | 线性无jitter | → 加 jitter + 解析 retry-after |
| ECONNRESET | 禁用keep-alive+重建连接 | 无处理 | → 加 Connection: close 重试 |
| 流式 | 主路径+5种fallback | 无 | 暂不做（大重构） |
| 消息截断 | 4层compact | 无 | 暂不做（Phase 8） |
| 模型fallback | 3×529→切换模型 | 无 | 暂不做（单 provider） |

### 4a: 单次超时 18s → 120s

- **文件**: `retry.ts`
- **改动**: `perRequestTimeoutMs = 18_000` → `120_000`
- **理由**: 非流式 LLM 长上下文首 token 延迟可达 30-90s。18s 把正常请求也杀了

### 4b: 退避加 jitter

- **文件**: `retry.ts`
- **改动**: `1000 * Math.pow(2, attempt)` → `1000 * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5)`
- **理由**: 多个 Agent 同时重试同一 API → 惊群。jitter 把重试时间点分散

### 4c: 解析 retry-after 响应头

- **文件**: `retry.ts` 的 `fetchWithRetry`
- **改动**: 5xx/429 响应时检查 `r.headers.get('retry-after')`，有值则用该值替代计算出的退避
- **理由**: 服务器知道自己的恢复时间，比我们猜的准

### 4d: ECONNRESET 后禁用 keep-alive

- **文件**: `retry.ts` 的 `fetchWithRetry`
- **改动**: ECONNRESET/EPIPE 错误时，在重试的 `init.headers` 中加 `Connection: close`
- **理由**: keep-alive 池中的死连接会被复用导致连续失败。Claude Code 整个禁用了 keep-alive，我们只在这一个重试上加 close

### 4e: 错误分类增强

- **文件**: `retry.ts` 的 `isRetryable`
- **改动**: 增加 `529`（服务过载）、`overloaded`（JSON body 中的 overloaded_error）的识别
- **理由**: DeepSeek 可能返回 529 而非 503

---

## 修正 5: 观察 2 遗留——Agent 结果未到达主 Agent 上下文

观察 2 的修正（preRoundCheck 无条件 flush）已做，但可能还不够。

**补充方案**: AgentTool 的 background `.then()` 中，除了 `_notify`，额外用 `engine.pendingNotifications` 直接推一条强信号。同时 Agent 的 completeMember 之后，SyncTreeNode 将结果写入树节点——主 Agent 调 TreeCmd status 应该能看到。

**验证方式**: 观察下一次测试中 AgentTeam check 是否能读到子 Agent 的输出内容。

---

---

## 修正 6: 集群并发控制优化（针对观察 5）

### 根因
单调用不崩，集群崩——不是代码 bug，是并发策略太激进。6 个 Agent 同一毫秒内冲向 DeepSeek。

### 方案

**6a: ConcurrencyLimiter(3) → (2)**
- **文件**: `agent_def.ts`
- **改动**: `new ConcurrencyLimiter(3)` → `new ConcurrencyLimiter(2)`
- **理由**: 减少一个并发槽位，给 DeepSeek 减压

**6b: Agent 派发 stagger**
- **文件**: `AgentTool.ts`
- **改动**: 连续派发多个 background Agent 时，每个之间 stagger 500ms
- **理由**: 避免 6 个请求在 1ms 内同时到达服务器

### 影响
- 集群吞吐量略降（-33% 并发），但成功率大幅提升
- 对用户感知延迟影响极小（500ms stagger vs 多次失败+重试的几十秒）

---

## 改动汇总

| 修正 | 文件 | 行数 |
|------|------|------|
| 4a | retry.ts | 1 |
| 4b | retry.ts | 1 |
| 4c | retry.ts | +5 |
| 4d | retry.ts | +5 |
| 4e | retry.ts | +3 |
| **合计** | | **~15 行** |
