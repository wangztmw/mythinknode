# 修正计划（第二轮）— 治本

## 修正 7: CLI 渲染 bug（治本）

### 表象

`● Thinking (15.2s) — analyzingask tree  ● Thinking (0.0s) — analyzing`

### 根因深挖

不是 `\r` 的问题。是 **thinking_end 的文本长度 < thinking_tick 的文本长度** 导致的残留字符覆盖不全：

```
thinking_tick 写的行（较长）:
\r  ● Thinking (15.2s) — analyzing → 3 tools

thinking_end 写的行（较短，没有 → 3 tools 后缀）:
\r  ● Thinking (15.2s) — analyzing\n

结果: 屏幕上 " → 3 tools" 没被覆盖，残留在行尾。
      下一行 thinking_start 从 column 0 开始写，旧残留被渲染到了新行前面？
      不对——\n 之后光标在下一行 column 0。但如果 \n 之后 terminal 没来得及 flush，
      下一个 write 先到了，就可能混在一起。
```

真正原因：`thinking_end` 的 `\n` 是**嵌在字符串里**的。Node.js 的 `stderr.write` 是异步的——操作系统可能把两次 `write` 的字节合并到一个缓冲区。如果 `thinking_end` 的最后一个字节（`\n`）和下一个 `thinking_start` 的第一个字节在同一个 tty 写操作中到达终端，终端驱动就分不清了。

而且 `thinking_tick` 的残留字符（` → 3 tools`）没有被清除——`\r` 只回到行首不擦除，需要用 `\x1b[K`（ANSI 擦除到行尾）。

### 治本方案

1. `thinking_end` 写完后加 `\x1b[K` 清除行尾残留
2. `thinking_end` 末尾加 `\r` 确保光标真的在行首（`\n` 不一定在所有终端上可靠地移光标到行首）
3. `thinking_start` 加 `\r` 兜底

**文件**: `cli.ts` — `renderProgress`

## 修正 8: Agent 输出读不到（治本）

### 表象

Agent 完成后 AgentTeam check 返回空内容。`readMemberOutput` 找不到文件。

### 根因深挖

不是"新路径 vs 旧路径"的问题。是 **`addMember` 从未收到真实的 sessionId**。

追踪链路：

```
AgentTool.call() → addMember('local_agent', ...)
  → _sessionId = sessionId || 'default'
  → sessionId 参数未传 → 永远是 'default'
  → Agent 输出写入 sessions/default/agents/{id}.txt

AgentTool 完成 → completeMember(task.id, result.text)
  → saveMemberOutput(m._sessionId, id, text)
  → 写入 sessions/default/agents/{id}.txt ← 对，这里写和读一致
```

但问题不在这里。真正的问题是 **AgentTool 创建 Agent 时，engine.activeTreeId 没有被传给 addMember**。`_sessionId` 永远是 `'default'`，但树用的是真实 sessionId（比如 `2026-08-06T12-00-00`）。树文件在 `sessions/{realId}/tree.json`，Agent 输出在 `sessions/default/agents/{id}.txt`——**两个不同的目录**。

而且更严重的是：如果同一台机器上跑了两个 mycoder 进程（两个不同 session），它们的 Agent 输出都会写到同一个 `sessions/default/agents/` 目录，互相覆盖。

### 治本方案

1. `AgentEngine` 加 `sessionId` 字段（Mycoder.ts 创建 engine 后设置）
2. `AgentTool.call()` 中 `addMember` 时传入 `_engine.sessionId`
3. 删除旧路径 fallback（治标代码）——不需要了

**文件**: `agent_def.ts`（加字段）+ `AgentTool.ts`（传 sessionId）+ `agent_team.ts`（删 fallback）
