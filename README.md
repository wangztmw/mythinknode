# mythinknode

一个极简 AI 编码 Agent。

当前各种 Agent 的最简框架，可以归结为一句话：

```
session_loop × query_loop（LLM × tool）
```

`session_loop` 管一条会话的完整管线（前置检索 → 执行 → 反思 → 压缩），`query_loop` 管单轮 LLM ↔ tool 循环。二者叠加，就是 Agent 的全部骨架。

**~4,300 行 TypeScript · 13 个工具 · 零运行时依赖（除 zod）· 零遥测。**

---

## 为什么会有这个项目

为了探索**智能组件**的可能性。具体两条线：

- **智能搜索算法** —— 让大模型根据标签（keywords）与树结构实现高效搜索。不是把答案向量化整块喂给模型，而是让它沿着标签和树的分支自己找到路。
- **智能管理** —— 让大模型区分知识的内在结构，并通过人机协同构建知识体系。Agent 在循环中打标签，模型在会话后反思落盘，知识树在人机协同中生长。

这两条线共同落在 NodeMind 上——下面是它和其余几个设计点，按价值排序。

---

## 核心创新

### 1. NodeMind —— 体系知识管理（原生 AI 搜索 + 逻辑树保持）

这是整个项目最核心、也是其他编码 Agent 都没有的原创设计。

**问题**：每次对话从零开始。Agent 不记得上次踩过的坑、跑通的路线、有效的工具组合。传统 RAG 把答案向量化后整块喂给模型——但这会把上下文窗口塞爆，而且"喂答案"不等于"教会模型怎么用"。

**解法**：**体系知识管理（原生 AI 搜索 + 逻辑树保持）**——不把答案喂给 Agent，而是告诉它**答案在哪条路上**，让它自己一层层走下去。

```
~/.mythinknode/nodemind/
└── root/
    ├── dev-experience/        ← 父节点只知道子节点的 keywords
    │   └── rest-auth/         ← 子节点存完整经验（内容 + attrs）
    ├── tool-usage/
    └── lessons/
        └── session-20240809/  ← 每轮 session 自动沉淀的经验节点
```

三个反直觉的设计，正好对应上面两条线：

**智能搜索算法**
- **单层搜索 + Agent 驱动深入**：搜索**只查一层**，返回 `{ matches, deeperIds, deeperHints }`。深入的权利交给 Agent 自己——它用 `Knowledge(read)` 逐节点加载，觉得不够再往下走。不是系统"推"信息，是 Agent"拉"信息。比递归多轮 LLM 路由快一个数量级，且不会一次性灌入海量文档。

**智能管理（逻辑树保持）**
- **分层导航，信息散布**：父节点只存 `keywords[]`（"我跟什么有关"），不存正文。LLM 必须沿路径走——读根节点 → 决定深入哪个分支 → 读子节点 → 继续或停止。上下文永远可控。
- **Remember 标记、Reflector 落盘（人机协同）**：Agent 循环中随时用 `Remember(action='tag')` 打 `[REMEMBER_TAG]` 标记（只入队列，不写树）；session 结束后由 **Reflector 作为树的唯一写入入口**，用 LLM 分析完整工具日志，决定"创建/更新/跳过"。写入权集中，树结构永不腐坏。

**失败比成功更有价值**：反思提示词明确要求记录失败路线——"试了 X 失败，Y 也失败，Z 成功"比"Z 成功"有用十倍。每个 gotcha 按 **Symptom → Root Cause → Fix** 三段式落盘。

### 2. 上下文独立的 Agent 调度 —— 用好有限的上下文窗口

主 Agent 和子 Agent 的区别在于**上下文独立**。上下文窗口是有限的——当主 Agent 的 message（会话、知识、信息）累积过多、窗口吃紧时，把子任务调度给子 Agent，让子 Agent 在自己的独立上下文里跑，跑完只回传结论。

这样把有限的上下文窗口用在刀刃上：主 Agent 只保留"任务 + 结论"，过程留在子 Agent 的独立上下文里。

协调是**信号制**，不是内容制：

- 子 Agent 用 `[NEED: ...]`、`[FOUND: ...]` 标记主动向主 Agent 通信，而不是被动等召唤。
- 主 Agent 用 `Agent(action='wait_any')` 等"任意一个完成"，`Agent(action='check')` 拉报告，`Agent(action='direct')` 注入新指令，`Agent(action='kill')` 掐掉失控的。
- 后台 Agent 完成后只往通知队列塞一条**一句话信号**，主 Agent 需要时才去读完整报告。

### 3. Delta 上下文压缩 —— 只记录模型无法自己推导的东西

每个 session 结束后，`MessageProcessor` 用 LLM 把本轮消息压缩成五段式摘要（`GOAL → TIMELINE → FINDINGS → FILES → NUMBERS`），原文存盘（`raws/S{n}.json`），精简版追加到上下文。

- **Delta 原则**：只记模型自己推不出来的。砍掉推理噪音、原始 HTML/JSON、重复搜索结果、样板话术。
- **失败是高价值**：每个错误记录"试了什么 → 精确报错 → 下一步换什么"。
- **过程优于声明**：记"Write: src/auth/jwt.ts → 创建了 JWT helper"，不记"Agent 决定加认证"。

### 4. CJK 双宽感知的终端渲染 —— 治本，不是打补丁

中文/日文/韩文在终端占 2 列，ASCII 占 1 列。大多数 CLI 工具按"每个字符 1 列"算宽度，导致中文输出一缩窗口就复制乱码。

这里三层防御，全部在渲染源头解决：

1. **单通道 stdout**：所有输出走 stdout，不用 stderr，杜绝两路交错。
2. **宽度自适应**：≥60 列用 `\r` 原地覆写（正常体验），<60 列抑制中间 tick 帧（防止 `\r`+ANSI 折行刷屏）。
3. **CJK 双宽截断 + ANSI SGR 栈**：`charWidth()` 按码位判定双宽；折行时追踪活跃的 ANSI 格式码，断行后**重新注入**到续行——格式不丢。

> 这个 bug 折腾了 7 次失败的尝试，最终根因是 **ANSI 转义序列被物理截断跨行边界**导致状态机损坏。修复方式不是事后 patch，而是从渲染源头重构。

### 5. LLM 网络可靠性 —— 生产级重试策略

`src/llm/retry.ts` 实现了生产级的重试策略：

- **瞬态错误重试 10 次**，永久错误（DNS/鉴权）立即失败并给明确提示。
- **指数退避 + 25% jitter**（防惊群），优先读 `retry-after` 响应头。
- **ECONNRESET → 下次请求禁用 keep-alive**（避免复用死连接）。
- **529 / overloaded 识别**（服务过载，值得重试）。
- **并发信号量**：主 Agent + 所有子 Agent 共享一个计数器（默认 2），超出排队 FIFO，120s 超时兜底——防止多 Agent 同时轰炸 API 触发 429。

---

## 架构

```
src/
├── Mythinknode.ts          入口：配置 → LLM → 工具 → 引擎 → REPL
├── session_loop.ts         Session 循环：前置检索 → query_loop → 反思 → 压缩
├── query_loop.ts           单轮 LLM ↔ tool 循环
├── agent/
│   └── agent_def.ts        引擎：系统提示词 + Agent 状态表 + 子 Agent 提示词
├── cli/
│   ├── cli.ts              REPL + 统一 stdout 渲染（宽度自适应）
│   ├── config.ts           配置持久化（~/.mythinknode/）
│   ├── render/             Markdown→ANSI（CJK 双宽）+ 折行保护
│   └── monitor/            ProgressEvent 事件合同 + 轮询
├── llm/                    双 Provider（Anthropic + OpenAI/DeepSeek）+ 重试 + 并发
├── session/                会话持久化 + 消息压缩（MessageProcessor）
├── nodemind/               树状经验图：Store / Navigator / Reflector
└── tools/                  13 个工具
    ├── core/               Tool 接口 + buildTool 工厂
    ├── agent/              Agent（spawn/check/wait_any/direct/kill）
    ├── file/               Read / Write / Edit / Glob / Grep
    ├── exec/               Bash
    ├── search/             WebSearch（Tavily）/ WebFetch
    ├── external/           MCP / Skill
    └── nodemind/           Knowledge（search/read/browse）/ Remember（tag）
```

**一次 Session 的完整管线**：

```
CLI 输入 → Session 管理 → NodeMind 前置检索 → query_loop（LLM + 工具）
    → NodeMind 后置反思 → MessageProcessor 压缩 → CLI 渲染 → 持久化
```

7 个模块各守一段管线，通过 `session_loop.ts` 串联。模块内部自由，模块间只有一种耦合：**数据进、数据出**。

---

## License

MIT
