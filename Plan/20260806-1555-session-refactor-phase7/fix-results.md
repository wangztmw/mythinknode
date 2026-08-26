# 修正结果

## 修正 1 结果: WorkTree 思考阶段有进度显示了

- **做了什么**: thinker.ts 加 `onProgress` 参数 → callLLM 传入；session_loop Phase C 传 `params.onProgress`
- **达到了什么效果**: 用户发命令后立刻看到 "Thinking (Xs) — thinking task tree"，不再像卡死
- **和预期的差距**: 无。完全解决
- **是否继续迭代**: 否

## 修正 2 结果: 后台 Agent 通知实时回流

- **做了什么**: cli.ts preRoundCheck 从"只 flush [TREE] 前缀"改为"有通知就 flush"
- **达到了什么效果**: 每轮 agentLoop 迭代都检查 pendingNotifications，有就注入 messages。后台 Agent 完成的通知不再卡到下一轮用户输入才出现
- **和预期的差距**: 待测试验证。如果后台 Agent 在主 Agent callLLM 期间完成（不是在 preRoundCheck 检查点），仍有一轮延迟——但比以前等用户下一条消息好得多
- **是否继续迭代**: 待测试

## 修正 3 结果: Thinking 0.0s 不再卡住

- **做了什么**: agent_def.ts 中 `thinking_start` 移到 `lacquire()` 之后。thinkStart 也从 acquire 之后开始计时
- **达到了什么效果**: 用户看到的 "Thinking" 时间是实际请求时间，排队等槽位的时间不显示
- **和预期的差距**: 无。完全解决

## 修正 4 结果: LLM API 调用稳健性增强（基于 Claude Code 调研）

- **做了什么**: retry.ts 四项改动:
  1. 单次超时 18s→120s（不会误杀正常慢请求）
  2. 退避加 25% jitter（防多个 Agent 同时重试惊群）
  3. 优先 retry-after 响应头（服务器最清楚该等多久）
  4. ECONNRESET→下次重试 Connection: close（禁用 keep-alive 死连接）
  5. 529/overloaded 识别为重试
- **达到了什么效果**: 网络波动时更稳健，不会因为 18s 超时把正常慢请求杀掉
- **和预期的差距**: 部分达到。流式、消息截断、模型 fallback 三大项暂不做（需要更大重构）
- **是否继续迭代**: 否（本次修正范围到此）

## 修正 6 结果: 集群并发控制优化

- **做了什么**:
  1. ConcurrencyLimiter 从 3 降为 2
  2. AgentTool 中每个 background Agent 启动前加随机 0-500ms stagger
- **达到了什么效果**: 任意数量的并行 Agent 不会在同一毫秒内同时冲向 DeepSeek。单个调用稳定性和之前一样，集群模式下不再因为"同一瞬间轰炸 API"导致大模型过载崩溃
- **核心发现**: **每个子 Agent 的起点就是调大模型 API。** 6 个 Agent 同时 spawn → 6 个 agentLoop 同时启动 → 6 个 callLLM 同时到达 DeepSeek。即使 ConcurrencyLimiter 排队，拿到槽位的前几个也是在同一毫秒内发出请求的。单个调用从来不崩，集群就崩——不是因为集群代码有 bug，是因为**并发策略没考虑 API 的承受力**。修复不是只针对 6 个的场景——stagger 策略自适应任意数量的并行 Agent，随机分散启动时间，让请求平滑到达
- **和预期的差距**: 理想情况应该根据 API 返回的 429/529 自动降速，但目前靠 stagger + 限流器已能有效缓解
- **是否继续迭代**: 否
