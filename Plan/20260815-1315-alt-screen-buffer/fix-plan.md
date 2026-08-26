# 光标不一致修复（基于 c0084e2 稳定版）

> 状态：规划中
> 基础：c0084e2（用户验证过"内容正常"的版本）

## 根因（精确诊断）

`c0084e2` 的渲染逻辑，光标不一致的根源在 **settle 只清数据、不清屏幕**：

```
用户输入（增量 echo）→ 屏幕显示输入块，renderedLines=N
回车 settle → chars=[]，renderedLines=1  ← 但屏幕上的输入块没清掉！
renderResult → safeWrite("\n" + 回复)     ← 回复接在残留输入内容后
下一轮 readLine → 写 prompt              ← prompt 又接在回复后
```

问题：
1. settle 不清屏 → Agent 回复和残留输入内容粘连
2. renderedLines 重置 1，但屏幕残留折行输入块，行数对不上
3. 多 session 累积，光标错乱

## 修复（最小、聚焦）

| 改动 | 说明 |
|------|------|
| settle 清屏 | `\r\x1b[J\n`：回行首 + 清到行尾 + 换行，清掉残留输入块 |
| renderResult 去开头 `\n` | settle 已换行，不再多加空行 |

## 关键：为什么这是最小且安全的

- 只改 settle 和 renderResult 两个点
- 不动输入块的增量 echo（保持 c0084e2 的稳定行为）
- 不动 renderedLines 机制（保持 c0084e2 已验证正确的上移逻辑）

## 验证

1. prompt 不重复、不粘连
2. Agent 回复正常接在 thinking 后
3. 多轮对话，输入块和输出块不粘连
4. 触行末折行正常
