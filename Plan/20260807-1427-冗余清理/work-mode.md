# 工作方式 — 无变化

本次为纯删除，不改任何工作方式。MemberState 从 20 字段精简到 14 字段：

```
删除前:  id, type, status, subject, description, startTime, endTime,
         output, outputFile, outputOffset, notified, toolUseId,
         _sessionId, feedback, feedbackAt, depth, group, contextFiles,
         abortController, agentLoop, pendingInstruction
         = 20 字段

删除后:  id, type, status, subject, description, startTime, endTime,
         output, outputFile, notified, _sessionId, feedback, feedbackAt,
         group, contextFiles, abortController, agentLoop, pendingInstruction
         = 14 字段
```

Agent 集群的所有协同机制、变量、属性设置不受影响。
