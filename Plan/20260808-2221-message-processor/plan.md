# 设计方案

## 架构：两层存储 + 标记系统

```
session/
├── raws/                     ← 磁盘：全量原文
│   ├── S1.json               ← Round 1 的 5 条原始消息
│   ├── S2.json               ← Round 2 的 3 条原始消息
│   └── ...
│
messages[] (内存)              ← 传给 LLM：优化后数组
  [user: "搜十二生肖"]
  [user: "[S1] 搜索鼠生肖获2结果，鼠排第一因渡河比赛..."]
  [assistant: "十二生肖源于..."]
  [user: "再查星座"]
  [user: "[S2] 搜索星座获1结果，源于巴比伦..."]
```

## 数据流

```
Query 循环 Round N:
  → LLM 产出 rawDelta (5-10条原始消息)
  → agentLoop 返回 LoopResult

Session 循环（agentLoop 返回后）:
  1. processor.process(rawDelta)
     a. 存盘 raws/S{n}.json
     b. LLM 压缩 → compressed (1-2条)
     c. 返回 { tag, compressed }
  2. compressed 替换 messages 尾部的 rawDelta
  3. session.save()
```

## 文件变化

| 文件 | 变化 | 行数 |
|------|------|------|
| `session/message-processor.ts` | **新建**：MessageProcessor 类 | ~60 |
| `session/raw-storage.ts` | **新建**：saveRaw / loadRaw | ~20 |
| `session_loop.ts` | 改 3 行：记录 beforeLen → processor.process(delta) → 替换 | +5 |
| `agent/agent_def.ts` | 系统提示词加 [S{n}] 说明 | +1 |

## 压缩提示词

```
You are a context compressor. Extract key findings from this conversation round.

MUST preserve verbatim:
- File paths (src/foo.ts:42)
- Line numbers, error messages, numbers, command arguments

CAN drop:
- HTML/JSON raw text, duplicate search results, intermediate reasoning

Format: [S{n}] Topic: key findings separated by semicolons.
```

## 标记系统

- `[S1]` 出现在 optimizedMessages 中，LLM 能看到
- 需要查原文时 LLM 用 Read 去读 `~/.mythinknode/sessions/{id}/raws/S1.json`
- 系统提示词告知这个约定
