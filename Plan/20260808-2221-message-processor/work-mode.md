# 工作方式

## 当前依赖图

```
session_loop.ts:
  agentLoop(engine, { messages: session.messages })
  → session.save()   ← 直接存全量原文
```

## 修改后

```
session_loop.ts:
  beforeLen = session.messages.length
  agentLoop(engine, { messages: session.messages })
  delta = session.messages.slice(beforeLen)          ← 本轮新增
  compressed = await processor.process(delta)        ← 压缩
  session.messages = [
    ...session.messages.slice(0, beforeLen),         ← 旧消息不动
    ...compressed                                    ← 替换尾部
  ]
  session.save()
```

## 新增模块

```
session/
├── session.ts              ← 不变
├── message-processor.ts    ← NEW: MessageProcessor 类
└── raw-storage.ts          ← NEW: 磁盘读写 raws/
```

## 文件访问模式

```
写入：processor.process(delta)
  → raw-storage.saveRaw(session.id, tag, delta)
  → ~/.mythinknode/sessions/{id}/raws/S1.json

读取：LLM 调 Read 工具
  → ~/.mythinknode/sessions/{id}/raws/S1.json
```
