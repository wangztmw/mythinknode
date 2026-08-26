# Claude Code Token 计数机制

> **日期**：2026-08-05
> **源码**：`utils/tokens.ts` + `services/tokenEstimation.ts`
> **动机**：理解 CC 如何在不调 tokenizer 的情况下，快速估算消息数组的 token 数

---

## 一、核心思路

不调 tokenizer。用 **API 返回的精确 usage + 新消息的字符数估算**。

```
tokenCount = 最后一次 API 的精确值 + 之后新消息的估算值
```

---

## 二、入口函数

**文件**：`utils/tokens.ts` L226

```typescript
export function tokenCountWithEstimation(messages): number {
  // 从后往前扫，找到最后一条带 usage 的消息
  let i = messages.length - 1
  while (i >= 0) {
    const usage = getTokenUsage(messages[i])
    if (usage) {
      // 找到了：精确 + 估算
      return (
        getTokenCountFromUsage(usage) +
        roughTokenCountEstimationForMessages(messages.slice(i + 1))
      )
    }
    i--
  }
  // 整个数组都没有 usage → 纯估算
  return roughTokenCountEstimationForMessages(messages)
}
```

---

## 三、精确部分：从 API 拿真实值

**文件**：`utils/tokens.ts` L46

每次 Anthropic API 响应都带 `usage` 对象。CC 把它挂在对应的 assistant 消息上。

```typescript
getTokenCountFromUsage(usage) =
  usage.input_tokens                    // 输入
  + usage.cache_creation_input_tokens   // 缓存写入
  + usage.cache_read_input_tokens       // 缓存命中
  + usage.output_tokens                 // 输出
```

**什么时候消息上有 usage？** 每次 API 调用的 `message_delta` 事件会写回 `usage` 和 `stop_reason` 到最后一条 assistant 消息上。

---

## 四、估算部分：字符数 ÷ 4

**文件**：`services/tokenEstimation.ts` L203

```typescript
roughTokenCountEstimation(content):
  Math.round(content.length / 4)   // 4 字符 ≈ 1 token
```

遍历待估算的每条消息，取文本内容长度 ÷ 4，累加。

JSON 文件特殊处理（L215）——因为 `{` `}` `:` `"` `,` 都是单字符独立 token：

```typescript
bytesPerTokenForFileType('json'): 2   // 2 字符 ≈ 1 token
bytesPerTokenForFileType(其他):   4
```

---

## 五、为什么这样设计

```
messages = [user, assistant(usage=5000), user(300字符), assistant(usage=2000)]
                           ↑                            ↑
                     精确：5000                      精确：2000

tokenCountWithEstimation:
  倒着扫到 messages[3] → usage=2000
  = getTokenCountFromUsage(2000)       ← 精确
  + roughTokenCount(messages[4..])    ← 空：0
  = 2000
```

**新会话**（还没调过 API）：

```
messages = [user(1500字符)]
  无 usage → 纯估算: 1500/4 = 375
  误差大，但上下文小，离窗口上限远，无所谓
```

**长对话**（调过多次 API）：

```
messages = [...大量历史(最后一条带usage), 本轮工具结果(800字符)]
  精确部分占绝对大头，估算的 800/4=200 误差可忽略
```

---

## 六、其他 token 函数

| 函数 | 用途 |
|------|------|
| `tokenCountFromLastAPIResponse` | 仅从最后一条 API 响应拿精确值（不估算新消息） |
| `finalContextTokensFromLastResponse` | 拿 API 返回的 `usage.iterations[-1]`，用于 task_budget 计算 |
| `messageTokenCountFromLastAPIResponse` | 仅拿 output_tokens（不含输入） |
| `getCurrentUsage` | 返回最后一条的完整 usage 对象 |
| `doesMostRecentAssistantMessageExceed200k` | 最后一条 assistant 是否超 200K token |
| `getAssistantMessageContentLength` | assistant 消息的内容字符数（text + thinking + tool_use input） |

---

## 七、与 Mycoder 的关系

Mycoder 目前没有任何 token 计数机制——系统提示词固定 40 行，短会话不会超。

需要时可以直接复用这个两层方案（DeepSeek API 也返回 usage），核心代码不到 30 行。
