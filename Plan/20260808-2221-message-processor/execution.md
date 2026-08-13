# 执行步骤

## Step 1: 建 `session/raw-storage.ts`

- `saveRaw(sessionId, tag, delta)` — 写 JSON 到 sessions/{id}/raws/{tag}.json
- `loadRaw(sessionId, tag)` — 读 JSON

## Step 2: 建 `session/message-processor.ts`

- MessageProcessor 类：constructor(llm)
- `process(delta: ChatMessage[]): Promise<{tag, compressed}>`
- 内部：自增 counter → S{n} 标记 → 存盘 → LLM 压缩 → 返回

## Step 3: 改 `session_loop.ts`

- agentLoop 前后记录 beforeLen
- 取 delta → processor.process(delta) → 替换尾部

## Step 4: 改 Mythinknode.ts

- 创建 MessageProcessor 实例，传给 runSession

## Step 5: 改 `agent/agent_def.ts`

- 系统提示词加 [S{n}] 标记说明

## Step 6: 编译 + 烟雾测试

```bash
npx tsc --noEmit && npm run build
echo "/exit" | node dist/Mythinknode.js
```

## 测试观察 (2026-08-08 22:58)

### 问题：max_rounds 导致的 tool_use 断链

测试"搜国内Agent产业"时，agentLoop 跑满 25 轮。第 25 轮 LLM 调了 Agent(wait_any)，tool_use 被 push 进 messages，但还没等到 tool_result 返回，max_rounds 就触发了退出。

**时序**：
1. 第 25 轮: LLM → tool_use(Agent wait_any) → push 进 messages
2. agentLoop: maxRounds 到了 → 强制退出
3. messages 里残留：未配对的 tool_use（没有 tool_result）
4. MessageProcessor 处理这个 delta → 原样保留 tool_use + 压缩 tool_result
5. 下一轮 LLM 调用 → API 400: "tool_calls must be followed by tool messages"

**根因**：agentLoop 在 tool_use 未完成时就因 max_rounds 退出了。MessageProcessor 原样保留了 tool_use（正确的），但没有配对的 tool_result。

**修复**：MessageProcessor 跳过含 tool_use 的 delta（已实施）。agentLoop 的 max_rounds 退出时也应清理未完成的 tool_use。

### 额外发现：summarize 在消息破损时失败

/exit 时 summarize() 看到破损的 messages → LLM 调用可能失败 → 保留原始时间戳文件名。正常时会重命名为 "20260808-1434-主题名"。
