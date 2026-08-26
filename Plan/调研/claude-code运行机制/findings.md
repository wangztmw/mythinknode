# Claude Code 执行机制完整研究

> **日期**：2026-08-04
> **源码**：`/Users/Zhuanz1/Desktop/CLit/study/claude-code/claude-code-main/src/`
> **分析文件**：query.ts (1729行) + QueryEngine.ts (1295行) + helpers (731行) + toolExecution.ts + StreamingToolExecutor.ts = 3755行核心

---

## 核心结论

Claude Code **没有管道**。它的架构是**单层流式反应循环**——LLM输出驱动工具执行，工具结果驱动下一轮LLM。全部在 `queryLoop()` 的一个 `while(true)` 里完成。

我们设想的 Think→Act→Orchestrate 三段管道是**更清晰的架构**——Claude Code追求性能和容错，管道追求模块化和可测试性。

---

## 一、执行机制全景

```
QueryEngine.submitMessage()          ← 外层（1295行）
│
├─ processUserInput()                ← 输入预处理：图片/附件/MCP
├─ canUseTool() wrapper              ← 权限跟踪：记录所有拒绝
├─ recordTranscript()                ← 持久化：写磁盘做账
│
├─ for await (msg of query({         ← 内层入口（1729行）
│     messages, systemPrompt,
│     canUseTool, tools, maxTurns
│   })) {
│     switch(msg.type) {
│       case 'assistant': ...        ← LLM回复
│       case 'user':      ...        ← 工具结果
│       case 'stream_event': ...     ← 流式事件
│       case 'system':     ...       ← 压缩边界
│     }
│   }
│
└─ yield result                      ← 组装最终结果
```

**关键**: `query()` 不是"调用一次返回一次"。它是一个 `AsyncGenerator`——LLM的每一段输出、每一个工具结果都从里面流出来。外层逐条吃消息、逐条处理。

---

## 二、五层精妙机制

### 1. 流式工具执行（StreamingToolExecutor）

```
LLM输出:   "我来读..."  [tool_use:Read(a.ts)]  "还要..."  [tool_use:Grep]  "完成了"
               │                │                    │            │              │
               └─ 文本块 ───────┴─ 工具立即入队执行 ──┴─ 文本块 ───┴─ 工具入队 ──┘
                                        │                                      │
                                        └─ Read开始跑                         └─ Grep开始跑
                                        （LLM还在说"还要..."）                 （和Read并行）
```

**算法**: 
- `addTool()` 工具流式到达时立即入队
- 并发安全工具（WebSearch/Read）→ 无等待立即并行执行
- 非并发安全工具（Bash）→ 等待所有正在跑的工具完成，再独占执行
- `getCompletedResults()` 工具完成时FIFO出队，结果通过yield返回给外层
- 如果流式回退触发 → `discard()` 清空所有已入队但未完成的结果

### 2. 状态不可变更新

```typescript
let state: State = { messages, toolUseContext, turnCount: 1, ... }

while (true) {
  const { messages, turnCount } = state  // 解构当前状态
  
  // ... LLM调用 + 工具执行 ...
  
  // 多个 continue 站点，统一模式：
  state = { ...state, messages: newMessages, turnCount: turnCount + 1 }
  continue
}
```

**为什么这样做**: 7个continue站点（正常工具循环、autocompact retry、reactive compact retry、模型回退、max_tokens恢复、collapse drain retry、snip continuation），每个站点都要更新状态。展开语法保证遗漏某个字段时TypeScript报错，而不是静默覆盖。

### 3. 权限函数注入

```typescript
// 外层 QueryEngine
const wrappedCanUseTool = async (tool, input, ctx, msg, toolUseID) => {
  const result = await canUseTool(tool, input, ctx, msg, toolUseID)
  if (result.behavior !== 'allow') {
    this.permissionDenials.push({ tool_name, tool_use_id, tool_input })
  }
  return result
}

// 注入到 query()
query({ ..., canUseTool: wrappedCanUseTool })
```

**好处**: query()不知道权限怎么判断的——只知道"这个工具能不能用"。QueryEngine不知道query()什么时候调权限——只知道"有没有被拒绝"。两个模块通过一个函数参数完全解耦。

### 4. 模型回退

```
首次尝试（opus）→ 429/5xx/流式失败
  → 清空全部中间状态（assistantMessages, toolResults, toolUseBlocks清零）
  → 创建新的StreamingToolExecutor
  → 切换到fallback模型
  → 重新流式调用
  → 两种模型的结果不会交叉污染
```

### 5. 上下文压缩三重奏

| 机制 | 触发条件 | 做什么 |
|------|---------|--------|
| autocompact | token数超阈值 | 生成历史摘要，压缩成系统消息 |
| reactive compact | API返回413/媒体超限 | 同autocompact但跳过宽松检查 |
| snip | 单轮内增量 | 裁剪掉中间不重要消息释放空间 |

snip特别精巧——它注入一个回调函数，在query()的for-await循环里，每当移除了消息，就yield一个"tombstone"（墓碑）标记。SDK收到标记从UI移除对应消息。

---

## 三、和Mycoder的对比

| 维度 | Mycoder | Claude Code |
|------|---------|-------------|
| **核心循环** | 25轮 for 循环 | while(true) + needsFollowUp |
| **工具执行** | Promise.all 内联 | StreamingToolExecutor 流式并行 |
| **状态管理** | this.sessionMessages 直接mutate | 不可变State + 展开更新 |
| **权限** | 无 | canUseTool函数注入 |
| **流式** | 无 | AsyncGenerator逐块产出 |
| **回退** | 无 | 模型切换 + 状态清空 + 重试 |
| **压缩** | 无 | autocompact/reactive/snip三层 |
| **持久化** | session.ts 单次写 | recordTranscript逐步追写 |
| **代码量** | agent.ts 350行 | query.ts 1729行 |

---

## 四、哪些值得Mycoder学

| 机制 | 优先级 | 理由 |
|------|--------|------|
| **StreamingToolExecutor** | 高 | 并行执行 + 流式重叠，直接提升速度 |
| **状态不可变更新** | 中 | 防止bug，但当前continue站点少，收益有限 |
| **权限函数注入** | 中 | Phase 51已经在计划中 |
| **模型回退** | 低 | MyCoder用DeepSeek无fallback模型 |
| **上下文压缩** | 需要但不急 | 上下文小时无所谓，大时才需要 |

## 五、哪些不值得学

| 机制 | 理由 |
|------|------|
| 流式消息产出 | Node.js async generator在Mycoder单进程中复杂度收益比太低 |
| 墓碑/去重 | MyCoder无流式回退场景，不需要tombstone |
| autocompact | 上下文还不够大，等需要时再参考 |
| 权限跟踪数组 | 单人使用不需要审计 |

---

## 六、和管道模式的最终判断

Claude Code不是管道——它没有Think/Act/Orchestrate的阶段分层。它的组织方式是把所有逻辑塞进一个while(true) + async generator的循环里。这在高性能、高可靠场景下是对的——一个循环统一管理所有异常和状态。

但**管道模式更适合Mycoder**: MyCoder不需要1200行容错代码，它需要的是清晰的模块边界。Think/Act/Orchestrate三段分离让每个模块可以独立测试、独立替换——这是研究型项目的核心需求。

明天从`executeToolCalls()`抽离开始，这是迈向三段管道的实用第一步，也是Mycoder版"StreamingToolExecutor"的雏形。







## 发现



### 自顶向下



现在从文件结构出发，讲解claude code的执行机制，自顶向下地讲解吧                                                 



 Thought for **54s**, searched for **1** pattern, listed **1** directory (ctrl+o to expand)



⏺ 入口到工具执行，六个文件一线串下来：

   

 \---

 **文件结构 ≠ 执行流程**



 Claude Code 的 36 个顶层目录不是乱堆的——它们按职责分层。执行流程像水往下流，每层只管自己的事：



 entrypoints

  → QueryEngine (src/)

   → query (src/)

​    → services/api

​     → services/tools

​      → tools/ (每个工具)

​      各层旁边的 utils/hooks/state 是横切支撑



 \---

 **第一站：****entrypoints/cli.tsx** **— 入口**

 

 用户敲回车

  → cli.tsx 把用户输入包装成 SDKMessage

  → 调用 engine.submitMessage(prompt)

  → 拿到 AsyncGenerator

  → 逐条消费：assistant → 渲染到 Ink UI → user → 显示工具结果 → system → 处理通知

  → 直到 result 消息 → 一轮结束



 这是外部世界。engine 就是 QueryEngine 实例。



 \---

 **第二站：****src/QueryEngine.ts** **— 外核**

 

 async *submitMessage(prompt) {

  // 1. 组装上下文

  const { systemPrompt, userContext } = fetchSystemPromptParts(...)



  // 2. 预处理用户输入（slash命令、图片、附件）

  const { messages, allowedTools } = processUserInput(prompt, ...)



  // 3. 包一层权限跟踪

  const wrappedCanUseTool = (tool, ...) => {

   const r = await canUseTool(tool, ...)

   if (r.behavior !== 'allow') this.permissionDenials.push(...)

   return r

  }



  // 4. 进入核心循环

  for await (const msg of query({ messages, systemPrompt, canUseTool: wrappedCanUseTool, ... })) {

   switch (msg.type) {

​    case 'assistant': → 写磁盘 → yield 给 SDK

​    case 'user':    → 数轮次 → yield 给 SDK

​    case 'stream_event': → 跟踪 usage/stop_reason

​    case 'system':   → 压缩边界处理

   }

  }



  // 5. 拼装最终结果

  yield { type: 'result', duration_ms, num_turns, usage, ... }

 }



 QueryEngine 不知道 LLM 怎么调的、工具怎么跑的。只知道"收消息、做账、转发"。



 \---

 **第三站：****src/query.ts** **— 内核**

 

 两个生成器函数，1729 行：



 query(params)          ← 外层包装（20行）

  └─ queryLoop(params)     ← 真正干活（1500行）

​     │

​     ├─ ① 拆参数、初始化状态

​     │  state = { messages, toolUseContext, turnCount: 1, ... }

​     │

​     ├─ ② while (true) {   ← 核心循环

​     │

​     │   ③ 检查是否需要上下文压缩

​     │    autocompact? → 压缩 → state更新 → continue

​     │    prompt太长? → yield error → return

​     │

​     │   ④ 流式调用 LLM:

​     │    for await (msg of deps.callModel({     ← services/api/claude.ts

​     │     messages, systemPrompt, tools, signal

​     │    })) {

​     │     msg.type:

​     │      text_delta   → 累积到 assistantMessages

​     │      tool_use_block → StreamingToolExecutor.addTool()

​     │               → 工具立刻开始执行（不等待LLM说完）

​     │               → needsFollowUp = true

​     │      message_stop  → 流结束

​     │    }

​     │

​     │   ⑤ 等待剩余工具完成

​     │    getCompletedResults() → yield 每个 tool_result

​     │

​     │   ⑥ 检查结果:

​     │    needsFollowUp → 拼装消息 → state更新 → continue

​     │    !needsFollowUp → yield stopHook → return

​     │

​     │   ⑦ 异常处理:

​     │    模型回退 → 清空状态 -> 换模型 → continue

​     │    上下文溢出 → 压缩 → continue

​     │    max_tokens → 提上限 → continue

​     │ }



 \---

 **第四站：****services/api/claude.ts** **— 真正的 HTTP 调用**



 deps.callModel({

  messages, systemPrompt, tools, signal

 })

  → POST https://api.anthropic.com/v1/messages

  → streaming=true

  → 返回 ReadableStream

  → 逐块解析 SSE 事件:

​    content_block_start → 文字块/工具块开始

​    content_block_delta → 文字增量（"我来"→"读一下"→"README"）

​    content_block_stop  → 一块结束

​    message_delta    → stop_reason, usage

​    message_stop     → 整条消息结束

  → async generator yield 每一条解析后的事件



 这就是那行 for await (const message of deps.callModel(...)) 的源头。



 \---

 **第五站：****services/tools/StreamingToolExecutor.ts** **— 流式工具编排**

 

 addTool(block, assistantMessage):

  ① 找到工具定义（findToolByName）

  ② 加入内部队列 { id, block, status:'queued', isConcurrencySafe }

  ③ tryStartNextTool():



​    tryStartNextTool():

​     如果有非并发工具在执行 → 等

​     如果有并发安全工具在队列 → startTool()

​     如果只有非并发工具且无任何工具在跑 → startTool()



​    startTool():

​     调用 runToolUse(block, assistantMessage, canUseTool, toolUseContext)

​     → services/tools/toolExecution.ts



 **关键优化**：WebSearch、Read 这类读工具是并发安全的——可以在 Bash 跑着的时候同时执行。Bash、Write 这类写工具需要独占环境——排队等所有并发工具完成后再启。



 \---

 **第六站：****services/tools/toolExecution.ts** **— 单个工具执行**

 

 async function* runToolUse(toolUse, assistantMessage, canUseTool, ctx):

  ① 找工具 → findToolByName

  ② 校验输入 → tool.validateInput(input)

  ③ 权限检查 → canUseTool() → allow/deny/ask

  ④ 前钩子（pre-tool hooks） → 允许修改输入

  ⑤ 真正执行 → tool.call(input, ctx)

  ⑥ 后钩子（post-tool hooks） → 允许修改输出

  ⑦ 格式化结果 → formatToolResult → yield tool_result消息

  ⑧ 写统计 → 工具耗时/分析日志



 这就是单个工具从接收到返回的完整生命周期。



 \---

 **第七站：****src/tools/** **— 工具实现**

 

 BashTool/   → spawn子进程，权限判断，沙箱检查

 FileReadTool/ → 读文件，二进制检测，大小限制

 WebSearchTool/ → Anthropic原生搜索API（不是DuckDuckGo！）

 AgentTool/   → 创建子Agent，分配工具子集，监控状态

 ...



 每个工具是一个独立模块，自带 prompt、校验、权限判断、执行、渲染。



 \---

 **完整调用链（一次用户输入）**

 

 cli.tsx

  → QueryEngine.submitMessage()

   → processUserInput()       utils/processUserInput.ts (附件/MCP/文件)

   → query()             src/query.ts (外层包装)

​    → queryLoop()          src/query.ts (while(true) 循环)

​     → deps.callModel()       services/api/claude.ts (HTTP流式)

​      └─ POST /v1/messages     Anthropic API

​     → StreamingToolExecutor     services/tools/StreamingToolExecutor.ts

​      → runToolUse()        services/tools/toolExecution.ts

​       → tool.call()       tools/BashTool/...ts

​     → state = { ...state, ... }  更新状态 → continue

   → yield result           拼装最终结果

  → Ink UI 渲染            components/ (React/Ink)



 **与 MyCoder 对比**：MyCoder 的调用链是 3 个文件（MyCoder→agent→tool），Claude Code 是 6 层、36 个目录。不是因为 Claude Code

 功能多——是因为它把每个横切关注点（权限、压缩、钩子、流式）都做成了独立模块。MyCoder 的管道化不需要这么多层——但可以从这 6 层里抽明确定义的接口边界。



### 完整链路



/btw entrypoints                                                                        

   → QueryEngine (src/)                                                                    

​    → query (src/)                                                                      

​     → services/api                                                                     

​      → services/tools                                                                   

​       → tools/ (每个工具)                                                                 

​       各层旁边的 utils/hooks/state 是横切支撑                                                       

 这个工具链，还可以上下再延伸一些吗，让我看到最开始是哪个被启动，到哪里彻底结束                                         



 **/btw** entrypoints → QueryEngine (src/) → query (src/) → services/api → services/tools → tools/ (每个工具) 各层旁边的 utils/hooks/state 是横切支撑 这个工具链，…



  可以。把这条链往两头拉到最远：



  \---

  bin/claude               ← Shell入口，启动bun

   → entrypoints/init.ts         ← 环境初始化：特性开关、遥测、工作目录

​    → setup.ts             ← 读配置、建QueryEngine实例、挂载MCP

​     → entrypoints/cli.tsx       ← REPL入口：Ink渲染循环

​      │

​      │ 用户输入

​      │

​      ▼

​     → QueryEngine.submitMessage()   ← src/QueryEngine.ts：外核

​      → processUserInput()      ← utils/：slash命令、图片、附件

​      → query()            ← src/query.ts：内核入口

​       → queryLoop()         ← while(true) 循环

​        → services/api/claude.ts   ← HTTP流式调用 Anthropic API

​         → POST /v1/messages    ← 网络层

​        → StreamingToolExecutor   ← services/tools/：流式工具编排

​         → runToolUse()       ← services/tools/toolExecution.ts：单体工具

​          → canUseTool()      ← hooks/：权限检查

​          → hooks (pre/post)    ← hooks/：前后钩子

​          → tool.call()      ← tools/{Bash,Read,WebSearch,...}Tool/

​           → 子进程/文件系统/网络  ← 操作系统边界

​          ← tool result

​         ← 合并结果

​        ← messages更新 → state更新 → continue/return

​       ← yield result

​      ← yield result给SDK

​     → cli.tsx 消费 yield：

​       assistant消息 → Ink渲染 → 终端输出

​       user消息   → 工具结果显示

​       stream_event → 实时更新usage/stop_reason

​       result消息  → 一轮结束，显示耗时/token

​      │

​      │ prompt() → 等待用户下一条输入

​      │

​      ▼

​     → process.exit(0)         ← /exit或EOF





### 这种问答方式非常好

现在从文件结构出发，讲解claude code的执行机制，自顶向下地讲解吧                                                 



 Thought for **54s**, searched for **1** pattern, listed **1** directory (ctrl+o to expand)



⏺ 入口到工具执行，六个文件一线串下来：

   

 \---

 **文件结构 ≠ 执行流程**



 Claude Code 的 36 个顶层目录不是乱堆的——它们按职责分层。执行流程像水往下流，每层只管自己的事：



 entrypoints

  → QueryEngine (src/)

   → query (src/)

​    → services/api

​     → services/tools

​      → tools/ (每个工具)

​      各层旁边的 utils/hooks/state 是横切支撑



 \---

 **第一站：****entrypoints/cli.tsx** **— 入口**

 

 用户敲回车

  → cli.tsx 把用户输入包装成 SDKMessage

  → 调用 engine.submitMessage(prompt)

  → 拿到 AsyncGenerator

  → 逐条消费：assistant → 渲染到 Ink UI → user → 显示工具结果 → system → 处理通知

  → 直到 result 消息 → 一轮结束



 这是外部世界。engine 就是 QueryEngine 实例。



 \---

 **第二站：****src/QueryEngine.ts** **— 外核**

 

 async *submitMessage(prompt) {

  // 1. 组装上下文

  const { systemPrompt, userContext } = fetchSystemPromptParts(...)



  // 2. 预处理用户输入（slash命令、图片、附件）

  const { messages, allowedTools } = processUserInput(prompt, ...)



  // 3. 包一层权限跟踪

  const wrappedCanUseTool = (tool, ...) => {

   const r = await canUseTool(tool, ...)

   if (r.behavior !== 'allow') this.permissionDenials.push(...)

   return r

  }



  // 4. 进入核心循环

  for await (const msg of query({ messages, systemPrompt, canUseTool: wrappedCanUseTool, ... })) {

   switch (msg.type) {

​    case 'assistant': → 写磁盘 → yield 给 SDK

​    case 'user':    → 数轮次 → yield 给 SDK

​    case 'stream_event': → 跟踪 usage/stop_reason

​    case 'system':   → 压缩边界处理

   }

  }



  // 5. 拼装最终结果

  yield { type: 'result', duration_ms, num_turns, usage, ... }

 }



 QueryEngine 不知道 LLM 怎么调的、工具怎么跑的。只知道"收消息、做账、转发"。



 \---

 **第三站：****src/query.ts** **— 内核**

 

 两个生成器函数，1729 行：



 query(params)          ← 外层包装（20行）

  └─ queryLoop(params)     ← 真正干活（1500行）

​     │

​     ├─ ① 拆参数、初始化状态

​     │  state = { messages, toolUseContext, turnCount: 1, ... }

​     │

​     ├─ ② while (true) {   ← 核心循环

​     │

​     │   ③ 检查是否需要上下文压缩

​     │    autocompact? → 压缩 → state更新 → continue

​     │    prompt太长? → yield error → return

​     │

​     │   ④ 流式调用 LLM:

​     │    for await (msg of deps.callModel({     ← services/api/claude.ts

​     │     messages, systemPrompt, tools, signal

​     │    })) {

​     │     msg.type:

​     │      text_delta   → 累积到 assistantMessages

​     │      tool_use_block → StreamingToolExecutor.addTool()

​     │               → 工具立刻开始执行（不等待LLM说完）

​     │               → needsFollowUp = true

​     │      message_stop  → 流结束

​     │    }

​     │

​     │   ⑤ 等待剩余工具完成

​     │    getCompletedResults() → yield 每个 tool_result

​     │

​     │   ⑥ 检查结果:

​     │    needsFollowUp → 拼装消息 → state更新 → continue

​     │    !needsFollowUp → yield stopHook → return

​     │

​     │   ⑦ 异常处理:

​     │    模型回退 → 清空状态 -> 换模型 → continue

​     │    上下文溢出 → 压缩 → continue

​     │    max_tokens → 提上限 → continue

​     │ }



 \---

 **第四站：****services/api/claude.ts** **— 真正的 HTTP 调用**



 deps.callModel({

  messages, systemPrompt, tools, signal

 })

  → POST https://api.anthropic.com/v1/messages

  → streaming=true

  → 返回 ReadableStream

  → 逐块解析 SSE 事件:

​    content_block_start → 文字块/工具块开始

​    content_block_delta → 文字增量（"我来"→"读一下"→"README"）

​    content_block_stop  → 一块结束

​    message_delta    → stop_reason, usage

​    message_stop     → 整条消息结束

  → async generator yield 每一条解析后的事件



 这就是那行 for await (const message of deps.callModel(...)) 的源头。



 \---

 **第五站：****services/tools/StreamingToolExecutor.ts** **— 流式工具编排**

 

 addTool(block, assistantMessage):

  ① 找到工具定义（findToolByName）

  ② 加入内部队列 { id, block, status:'queued', isConcurrencySafe }

  ③ tryStartNextTool():



​    tryStartNextTool():

​     如果有非并发工具在执行 → 等

​     如果有并发安全工具在队列 → startTool()

​     如果只有非并发工具且无任何工具在跑 → startTool()



​    startTool():

​     调用 runToolUse(block, assistantMessage, canUseTool, toolUseContext)

​     → services/tools/toolExecution.ts



 **关键优化**：WebSearch、Read 这类读工具是并发安全的——可以在 Bash 跑着的时候同时执行。Bash、Write 这类写工具需要独占环境——排队等所有并发工具完成后再启。



 \---

 **第六站：****services/tools/toolExecution.ts** **— 单个工具执行**

 

 async function* runToolUse(toolUse, assistantMessage, canUseTool, ctx):

  ① 找工具 → findToolByName

  ② 校验输入 → tool.validateInput(input)

  ③ 权限检查 → canUseTool() → allow/deny/ask

  ④ 前钩子（pre-tool hooks） → 允许修改输入

  ⑤ 真正执行 → tool.call(input, ctx)

  ⑥ 后钩子（post-tool hooks） → 允许修改输出

  ⑦ 格式化结果 → formatToolResult → yield tool_result消息

  ⑧ 写统计 → 工具耗时/分析日志



 这就是单个工具从接收到返回的完整生命周期。



 \---

 **第七站：****src/tools/** **— 工具实现**

 

 BashTool/   → spawn子进程，权限判断，沙箱检查

 FileReadTool/ → 读文件，二进制检测，大小限制

 WebSearchTool/ → Anthropic原生搜索API（不是DuckDuckGo！）

 AgentTool/   → 创建子Agent，分配工具子集，监控状态

 ...



 每个工具是一个独立模块，自带 prompt、校验、权限判断、执行、渲染。



 \---

 **完整调用链（一次用户输入）**

 

 cli.tsx

  → QueryEngine.submitMessage()

   → processUserInput()       utils/processUserInput.ts (附件/MCP/文件)

   → query()             src/query.ts (外层包装)

​    → queryLoop()          src/query.ts (while(true) 循环)

​     → deps.callModel()       services/api/claude.ts (HTTP流式)

​      └─ POST /v1/messages     Anthropic API

​     → StreamingToolExecutor     services/tools/StreamingToolExecutor.ts

​      → runToolUse()        services/tools/toolExecution.ts

​       → tool.call()       tools/BashTool/...ts

​     → state = { ...state, ... }  更新状态 → continue

   → yield result           拼装最终结果

​     → state = { ...state, ... }  更新状态 → continue

   → yield result           拼装最终结果

​     → state = { ...state, ... }  更新状态 → continue

   → yield result           拼装最终结果

  → Ink UI 渲染            components/ (React/Ink)



 **与** **MyCoder** **对比**：MyCoder 的调用链是 3 个文件（MyCoder→agent→tool），Claude Code 是 6 层、36 个目录。不是因为 Claude Code 功能多——是因为它把每个横切关注点（权限、压缩、钩子、流式）都做成了独立模块。MyCoder 的管道化不需要这么多层——但可以从这

 6 层里抽明确定义的接口边界。
