# 测试观察记录

## 观察 1: WorkTree 思考阶段 CLI 无输出（像卡死）

- **触发条件**: 启动 mycoder，输入任何命令
- **现象**: 用户输入后，终端无任何反馈——没有 "Thinking" 动画，没有进度提示。直到 thinker 完成（5-20 秒后）才突然出现 Agent 派发信息
- **频率**: 每次都触发
- **根因推测**: `thinkWorkTree` 内部调 `callLLM` 时传的第三个参数 `onProgress` 是 `undefined`。callLLM 的 setInterval tick 需要 onProgress 回调才能显示 "Thinking (Xs)"。thinker 静默跑完，用户看到的是一段空白等待
- **用户体验**: 像程序卡死了

## 观察 2: 子 Agent 完成后结果未回流到主 Agent

- **触发条件**: 主 Agent 派发 3 个后台 Agent，AgentTeam wait 确认全部完成
- **现象**:
  1. Agent ×3 被派发（background=true）
  2. AgentTeam wait → "All 3 tasks completed"
  3. AgentTeam check → 显示 pending/completed 但内容为空
  4. AgentTeam inbox → "(inbox empty)"
  5. 主 Agent 判断"Agent 显示已完成但结果尚未注入本轮对话"
  6. 主 Agent 放弃等结果 → 自己重新调 WebSearch 干活
- **频率**: 每次都触发
- **关键线索**: "Agent 显示已完成但结果尚未注入本轮对话"——Agent 跑完了，completeMember 被调了，但结果没到达主 Agent 的上下文窗口
- **可能原因**:
  - `_notify` 推入了 `pendingNotifications`，但主 Agent 的 `preRoundCheck`/`flushNotifications` 没有在正确时机触发
  - 或者 AgentTool 的 background .then() 中 `_notify` 被调了，但主 Agent 在等的是 inbox，而结果走的是 notify → pendingNotifications
  - 两个通道：AgentTeam inbox 读 `pendingNotifications`，AgentTeam check 读 `readMemberOutput`——主 Agent 两个都试了，都没拿到

## 观察 3: "Unterminated string in JSON" 反复失败

- **触发条件**: DeepSeek API 白天高峰期，长上下文请求
- **现象**: `LLM call failed: Unterminated string in JSON: terminated` 连续出现。发了 6 次"继续"，每次都 JSON 解析失败
- **频率**: 高峰期高频触发
- **为什么发生**: DeepSeek 服务端写 HTTP 响应体写到一半就截断了。不是网络断（TCP 连接完好），是服务端自己没写完 JSON 就关了流。`r.json()` 解析到一半发现不完整 → 抛异常
- **为什么重试没用**: 重试用同一份 messages（同样的大上下文），发到同一个 API。高峰期每个请求都被同样截断——不是偶发，是系统性
- **"terminated" 后缀**: 我们的 `openai.ts` 错误消息截断到 200 字符导致的显示效果

## 观察 4: "Thinking (0.0s)" 持续显示

- **触发条件**: 长时间等待后新一轮 callLLM 开始
- **现象**: `● Thinking (0.0s) — analyzing` 出现后数字一直不动
- **频率**: 间歇
- **为什么发生**: `thinking_start` 事件在 `lacquire()` 之前就发射了。但 `setInterval` tick 在 `lacquire()` 之后才创建。中间排队等待 ConcurrencyLimiter 时，用户看到的是 0.0s 卡住——"准备发请求但还没轮到"

## 观察 5: 集群模式下 DeepSeek 频繁崩溃，单调用稳定

- **触发条件**: 主 Agent 一轮派 6+ 个 background Agent
- **现象**: 单个 API 调用很少失败。但集群同时派发时，Unterminated JSON/529/超时大幅增加
- **频率**: 高频（集群模式下几乎每次都触发）
- **根因推测**: 6 个 Agent 几乎同时启动 → ConcurrencyLimiter(3) 放行 3 个 → 3 个非流式大请求同时冲向 DeepSeek → 服务器过载/限流
- **用户直觉**: "集群构建太粗糙，调用太大胆"

## 观察 6: CLI 渲染 bug — 两个 Thinking 显示在同一行

- **触发条件**: WorkTree thinker 的 thinking_end 之后，主 Agent 的 thinking_start 紧接着输出
- **现象**: `● Thinking (15.2s) — analyzingask tree  ● Thinking (0.0s) — analyzing` — "thinking task tree" 和下一个 "Thinking" 挤在同一行
- **频率**: 间歇触发
- **根因推测**: `renderProgress` 的 `thinking_end` 写 `\r...\n`，但 `thinking_start` 写的是 `● Thinking (0.0s) — label`。如果 thinking_end 的 `\n` 之后的 thinking_start 调用时 stderr 缓冲区还没 flush，或者 `\r` 没有正确将光标移到下一行行首
- **注意**: thinking_start 写的是 `process.stderr.write(...)` 不带 `\r` 前缀——依赖前一个 thinking_end 的 `\n` 换行

## 观察 7: 集群执行过程冗长且不透明

- **触发条件**: 派发多个 Agent 后，Agent 完成但结果不回传
- **现象**: 总共耗时 1,215,041ms（20分钟）。主 Agent 在 19 轮循环中反复:
  AgentTeam wait/list/check/deep/inbox → TreeCmd status → 放弃等结果 → 自己搜 → LLM 崩 → 用户说"继续" → 又重复
- **用户直觉**: "过程很长，内容挤到一起，不清晰"
- **根本问题**: Agent 完成后结果不回流 → 主 Agent 不知道 Agent 干了什么 → 反复查询 → 浪费时间 + 积累大上下文 → DeepSeek 崩
- **系统缺陷**: 树和 Agent 之间的桥接仍然薄弱。Agent 结果应该自动写入树节点，AgentTeam check 应该直接看到结果，主 Agent 不应该需要 19 轮去"寻找"子 Agent 的输出

## 观察 8: Thinking 数字不持续跳动，会停在某个值很久然后突然跳

- **触发条件**: 正常使用中
- **现象**: Thinking 后面显示的时间（如 0.0s、0.6s）不连续跳动，会停在某个值，过一会突然跳到另一个值。用户感觉"它不会持续地去动那个数字"
- **频率**: 经常
- **初步修复**: setInterval 创建后立刻手动执行一次 tickFn，让 0.0s 更快被替代
- **用户质疑**: 这个修复是否治本？还是只解决了显示问题？

### 观察 8 根因分析（3 Agent 并行审计结论）

**错误直觉**："setInterval 在 await 期间不工作"。

**事实**：`setInterval(fn, 100)` 在 `await provider.call()` 期间**完全正常运行**。事件循环在 timer 阶段和 poll 阶段（等待网络 I/O）之间交替，每约 100ms 准时触发 tick 回调。

真正的原因有三个，按影响从大到小：

**原因 1（主因）：ConcurrencyLimiter 排队时间不可见。**

```
主 Agent Round 2: lacquire() → 两个槽位被后台 Agent 占满 → Promise 挂起
→ thinkStart 还没赋值（在 lacquire 之后）
→ thinking_start 还没发出
→ 终端空白，用户看到上一轮的 thinking_end 时间（如 5.3s）"停住"

[等待 3-10 秒后]
→ 槽位释放 → lacquire 返回
→ thinkStart = Date.now()
→ thinking_start 渲染 "Thinking (0.0s)"
→ 用户感知："卡了这么久，突然从 0.0 开始"
```

Fix 3（`thinking_start` 移到 `lacquire` 之后）已经解决了"把排队时间误算为 thinking 时间"的问题，但排队本身仍然不可见——用户看到空白而不知道排队在进行中。

**原因 2（渲染污染）：linger tick 竞态。**

```
T0: provider.call 返回 → thinking_end 写入 "\r...5.3s...\x1b[K\n"
T1: clearInterval(tick) — 停掉未来的调度
T2: 但一个 tick 回调已经在 macrotask 队列中，clearInterval 阻止不了它
T3: 这个 linger tick 执行 → 在 thinking_end 下方多写了一行残影
T4: thought 输出拼接在残影后面 → 视觉混乱
```

Fix: `cancelled` 标志——tickFn 检查 cancelled 为 true 时直接 return，不写 stderr。

**原因 3（设计特征）：多轮归零。**

每轮 callLLM 有独立的 `thinkStart`。工具执行期间的空白 + 下一轮从 0.0s 开始 = 用户感觉"数字在跳动"。

这不是 bug——是设计选择。如果要跨轮不归零，需要全局累计计时器，和当前 per-round 计时是不同的用户体验需求（用户可能更想看到"这一轮 LLM 花了多久"而非"总耗时"）。

### 修复总结

| 修复 | 对应原因 | 治本/治标 |
|------|---------|----------|
| Fix 3: thinking_start 移到 acquire 后 | 原因 1（排队时间不算 thinking） | 治本 |
| cancelled 标志防 linger tick | 原因 2（渲染污染） | 治本 |
| tickFn 立即执行 | — | 无效（与 thinking_start 输出重复，建议删除） |
| \x1b[K 清行尾 | 辅助 | 治本 |

## 观察 9: 子 Agent 卡住后不求助，主 Agent 不调控

- **触发条件**: 派发子 Agent 后，子 Agent 遇到困难（curl 被墙/超时）
- **现象**: 
  1. 子 Agent 默默卡死，没有写 [BLOCKED] 或 [FEEDBACK] 向主 Agent 求助
  2. 主 Agent 反复 check/wait/deep，等了 76 秒后自己做决策 kill
  3. 主 Agent 没有尝试 AgentTeam(direct) 给子 Agent 新指令
  4. 最终主 Agent 亲自上阵干活（curl × 8 次），子 Agent 全部废弃
- **频率**: 网络不稳定时高频
- **设计预期 vs 实际**:
  - 预期: 子 Agent 卡住 → 写 [BLOCKED: curl 被墙] → 主 Agent 看到 → AgentTeam(direct, "改用 WebFetch") → 子 Agent 继续
  - 实际: 子 Agent 静默卡死 → 主 Agent 等了 76 秒 → kill → 自己干

**根因深挖**：

反馈通道的触发点**只在 LLM 的思考文本里**。子 Agent 的 system prompt 有一行："如果任务无法完成，在思考中写[BLOCKED:原因]"。但有两个断层：

1. **触发断层**：子 Agent 卡在工具执行（`await curl` 不返回）→ LLM 根本没机会写 [BLOCKED]。标记只能出现在 LLM 回复的思考文本里，而 LLM 要等到工具执行完才能"说话"。如果工具执行卡住了，LLM 永远没机会写标记。

2. **认知断层**：主 Agent 的 prompt 写了"看到 blocked→AgentTeam(direct)"。但它先收到的是 AgentTeam wait "All completed"（Agent 进程确实结束了），然后是 check/deep 返回空。主 Agent 没看到 blocked 信号——因为子 Agent 根本没发。主 Agent 不认为这是"blocked"，认为这是"Agent 废了"→ kill。

**结论**：反馈不能只靠 LLM 自觉写标记。需要代码层补充——工具执行超时自动触发 feedback、Agent 用满轮次自动标记 blocked。

## 观察 10: 子 Agent 产出质量不高 → 主 Agent 拒绝并自己干

- **触发条件**: 派发子 Agent 后，子 Agent 完成了但结果不满足主 Agent 预期
- **现象**: 
  1. 主 Agent 按"信息源"分工（Agent ×3 各抓一个网站），而非按"交付物"分工（Agent ×2 各写一份报告）
  2. 子 Agent 完成了，AgentTeam wait 确认 "All 3 completed"
  3. 但主 Agent check 后认为"结果返回不完整"，直接放弃子 Agent 产出
  4. 主 Agent 自己调 Bash ×3 curl，亲自抓数据
- **用户直觉**: "既然大家根据 Task 来分工，说明 Task 做的不够好"
- **深层问题**:
  1. **任务分解质量**: 按"信息源"分解是过程导向，按"交付物"分解才是结果导向。前者容易产出碎片，后者直接产出可用报告
  2. **无迭代改进**: 主 Agent 跳过了"Agent A 你做的不够好，再搜一轮"的中间步骤，直接 kill + 自己干
  3. **子 Agent 失败原因不明**: 是 prompt 太模糊？round 不够？curl 命令写错了？主 Agent 没有诊断就直接放弃
  4. **缺少质量反馈环**: 主 Agent 可以对子 Agent 说"你的结果缺了新能源板块，补搜"，但目前没有这个行为模式
- **频率**: 复杂任务中高频

## 观察 11: 子 Agent 没有自纠错能力，主 Agent 被迫自己干基础工作

- **触发条件**: 主 Agent 自己抓数据（Bash curl ×12），只派子 Agent 做"整理报告"
- **现象**:
  1. 主 Agent 亲自干了最难的活（抓数据），把最简单的活（整理已有数据）派给子 Agent
  2. 子 Agent 连简单任务都没完成——AgentTeam check/deep 返回空
  3. 主 Agent 等了 42 秒后放弃，自己整理报告
  4. 整次会话中，子 Agent 的实际有效产出为零
- **根因分析（四层）**:

### 层 1: maxRounds=10 对复杂任务不够

子 Agent 的一个完整纠错周期:
  第 1-2 轮: 理解任务 → 发现数据缺失
  第 3-5 轮: 尝试补救（搜索/读文件）
  第 6-7 轮: 补救失败 → 换策略
  第 8-9 轮: 基于已有信息整理
  第 10 轮: 写 [DONE]

但实际中 WebSearch 超时、文件不存在——每个意外消耗 1-2 轮。10 轮跑完，Agent 可能才刚刚发现"我需要的数据在哪"。

### 层 2: 主 Agent 的分解没有考虑时序性

主 Agent 把"抓数据"和"整理报告"拆成并行任务。但"整理报告"依赖"抓数据"的结果。
正确的时序应该是: 抓数据 → 完成 → 整理报告。而不是两个同时派发。
主 Agent 的 Thinker 和 Planner prompt 都没有提到"检查义群之间的时序依赖"。

### 层 3: 主 Agent 没有保留任务指令再派的能力

当前行为: 子 Agent 失败 → 主 Agent 放弃 → 自己干。
缺失行为: 子 Agent 失败 → 主 Agent 分析原因 → 用更精确的 prompt 重新派一个新的子 Agent → 监督 → 收结果。

这需要主 Agent 的 prompt 明确告诉它"你可以重新派，换更好的 prompt"。

### 层 4: 理想模型 vs 现实

理想:
  主 Agent 只做编排——分解任务、派 Agent、监督、汇总
  子 Agent 做所有执行工作——搜索、分析、写报告
  父 Agent 基于子 Agent 的产出做合成，不重做基础工作

现实:
  主 Agent 亲自做了 80% 的活（curl ×12）
  子 Agent 产出为零
  主 Agent 的时间分配: 编排 10% + 亲自执行 90%

- **用户核心诉求**: "Agent 干所有的事，上交上一级 Agent。上一级基于内容重新干，但不干基础工作"

## 观察 12: CLI 输入行回退/长行时出现重复渲染

- **触发条件**: 在 mycoder 提示符下输入超长文本，或回退修改已输入的内容
- **现象**: 输入行自动复制出一行。用户没有发送，出现了两个相同的输入行
- **频率**: 长输入或回退编辑时触发
- **根因**: thinking 输出用 `\r` 操纵光标位置。agent 返回后 `rl.resume()` 立即重绘提示符，此时光标可能被 `\r` 带到了错误位置，readline 在错误位置重绘导致输入行重复
- **修复**: `rl.resume()` 前加 `\x1b[K\n` 清空当前行残留 + 换新行
- **状态**: ✅ 已修复

## 观察 13: "Thinking (0.0s)" 复发

- **触发条件**: LLM 调用返回极快（< 100ms），或 agent 等待后新一轮 callLLM 开始
- **现象**: `● Thinking (0.0s) — continuing` 再次出现
- **根因**: 两个来源:
  1. `thinking_start` 硬编码 `(0.0s)` ——即使 tickFn 立刻覆盖，仍有微秒级显示
  2. `thinking_end` 的 `elapsedMs` < 100ms → `(0/1000).toFixed(1)` = `"0.0"` ——数学正确但视觉误导
- **修复（治本）**:
  1. `thinking_start` 删除硬编码时间，只显示 `Thinking — label`
  2. `thinking_end` 当 elapsed < 100ms 时显示 `<0.1s`
- **状态**: ✅ 已修复

## 观察 14: 主 Agent 倾向于自己干，不等子 Agent

- **触发条件**: 子 Agent 返回慢/空/卡，主 Agent 有能力自己执行
- **现象**: 主 Agent 等待数十秒后放弃子 Agent，亲自 curl/WebSearch/Write
- **根因**: 主 Agent 同时拥有编排工具（Agent/AgentTeam/TreeCmd）和执行工具（Bash/Write/WebSearch）。当编排路径不顺，它自然切到执行路径——因为它对用户负责最终交付
- **设计矛盾**: "既当裁判又当运动员"——主 Agent 有执行能力，就不会充分信任子 Agent
- **Claude Code 对比**: Coordinator 没有文件读写工具，只能编排。编排是唯一交付路径
- **用户直觉**: "我们设置了多余的智能环节。对子Agent没啥帮助。主Agent想自己干来交付我"
- **可能方向**: 砍掉主 Agent 的执行工具（Bash/Write/WebSearch 只给子 Agent），让它只能通过子 Agent 交付

## 观察 15: Thinking 0.0s 仍然出现（修正后复发）

- **触发条件**: 快速连续的 callLLM（子 Agent 全部完成后主 Agent 下一轮）
- **现象**: `● Thinking (0.0s) — continuing` 再次出现
- **注意**: 修复已做（thinking_start 不显示时间 + thinking_end 最小显示 <0.1s），需确认是否重启后生效
