# Claude Code 子 Agent 与集群创建机制 — 完整调研报告与实施计划

> **日期**：2026-08-05
> **调研范围**：Notion 空间（项目/ 下的全部子页面）+ 本地项目文件（Plan/pipeline/、src/）+ Claude Code 完整源码（`study/claude-code/claude-code-main/src/`）
> **关联文档**：[[pipeline-design.md]]、[[plan-decouple-agent.md]]、[[plan-cluster-explore.md]]、[[conversation-log.md]]
> **前置分析**：[[claude-code-study/findings.md]]、[[claude-code-study/queryengine-analysis.md]]、[[claude-code-study/query-analysis.md]]、[[claude-code-study/helpers-analysis.md]]

---

## 一、调研了什么

### 1.1 Notion 空间

阅读了 `项目/` 下的全部页面，核心是 **"my-coder — Claude Code 精简重构项目"** 及其子页面：

| 页面 | 内容 |
|------|------|
| 主页面（my-coder — Claude Code 精简重构项目） | 19+ Phase 的完整工程记录，从 512K 行砍到 926 行再重建到 2,400 行 |
| Agent系统设计与重构（2026-08-02） | Phase 22-44 的 14 个提交：Task 系统、消息队列、语言分层、远程调控、性能优化 |
| 完整代码解析（v0.5.0） | 27 文件/1,436 行逐文件注释，12 个工具详解，数据流全景 |
| v0.5.0 源码解析 | 五层分层架构：LLM → 工具 → 引擎 → CLI → 入口 |

关键数据点：
- 17 个 Git 提交，每个只做一件事
- 核心链路：`Agent(spawn)` → `taskRegistry` → `runSubAgent` → `Task(list/check)` 监控 → `Task(direct)` 调控 → `Task(kill)` 终止 → `notify()` → `pendingNotifications` → `flush`
- 6 条核心经验（Zod `.default()` 陷阱、`.then().catch()` 必备、通知不能直接 push 进 sessionMessages、提示词语气决定 Agent 性格、指令注入不需要 IPC、Terminal 崩溃不是 ANSI 码的错）

### 1.2 本地项目文件

| 文件 | 行数 | 角色 |
|------|------|------|
| `src/agent.ts` | 353 | 核心引擎：主 Agent 25 轮循环 + 子 Agent 10 轮引擎 + ProgressEvent 事件 |
| `src/task.ts` | 116 | Task 生命周期：共享注册表 + 磁盘持久化（原子写入） |
| `Plan/pipeline/pipeline-design.md` | — | 管道模式设计：Think/Act/Orchestrate 三段 + AgentContext 公文包 |
| `Plan/pipeline/plan-decouple-agent.md` | — | 解耦第一步：executeToolCalls() 抽离方案（含详细伪代码） |
| `Plan/pipeline/plan-cluster-explore.md` | — | 集群探索：角色化集群（Scout/Builder/Reviewer/Reporter）+ 动态 vs 固定角色 |
| `Plan/multi-agent-plan.md` | — | 方案 A（并行 Fork）+ 方案 B（Task 工具体系） |

### 1.3 Claude Code 源码

调研了以下核心模块：

| 模块 | 行数 | 角色 | 关键发现 |
|------|------|------|---------|
| `query.ts` | 1,729 | 核心循环 | `while(true)` + AsyncGenerator，7 个 continue 站点用于容错恢复，不是管道 |
| `QueryEngine.ts` | 1,295 | 会话外壳 | 双消息数组（mutableMessages + messages），processUserInput → query → result |
| `AgentTool.tsx` | 1,397 | Agent 创建调度中心 | 五种路由分支：Regular/Fork/InProcessTeammate/tmux/Remote |
| `runAgent.ts` | 973 | 子 Agent 执行引擎 | AsyncGenerator，独立 ToolUseContext，MCP 初始化，finally 清理 |
| `forkSubagent.ts` | 210 | Fork 机制 | 继承父上下文 + 占位 tool_result → 最大化 prompt cache |
| `Tool.ts` | 792 | 工具接口 | buildTool 工厂 + TOOL_DEFAULTS 默认 fail-closed |
| `tools.ts` | 389 | 工具注册 | getAllBaseTools → getTools(filters) → assembleToolPool(merge MCP) |
| `builtInAgents.ts` | 72 | 内置 Agent 注册 | 6 种类型：general-purpose/Explore/Plan/verification/statusline-setup/claude-code-guide |
| `coordinatorMode.ts` | 560 | 协调者模式 | 系统提示词替换 + Worker 受限工具集 + Research→Synthesis→Implementation→Verification 工作流 |
| `utils/swarm/` | 14 文件 | 多 Agent 集群 | inProcessRunner/spawnUtils/teamHelpers/teammateInit/leaderPermissionBridge |

---

## 二、核心发现

### 2.1 Claude Code 没有管道——它是单层流式反应循环

之前设想的 Think→Act→Orchestrate 三段管道是更清晰的架构。Claude Code 的实际组织方式是把所有逻辑塞进 `queryLoop()` 的一个 `while(true)` + AsyncGenerator 循环里。它的 7 个 continue 站点不是为了模块化——每条都是一条逃生路线（模型回退、上下文压缩、max_tokens 恢复）。**管道模式更适合 Mycoder**——Mycoder 不需要 1,200 行容错代码，它需要清晰的模块边界。

### 2.2 子 Agent 创建有五种模式，不是一种

```
Claude Code 子 Agent 创建
├── 1. Regular Agent        subagent_type 指定，全新上下文
├── 2. Fork Agent           省略 subagent_type，完全继承父上下文（prompt cache 优化）
├── 3. In-Process Teammate  name + team_name，同一 Node 进程，AsyncLocalStorage 隔离
├── 4. Process Teammate     name + team_name，独立 OS 进程（tmux/iTerm2），文件邮箱通信
└── 5. Remote Agent         isolation:"remote"，CCR 云端执行，事件流轮询
```

Mycoder 目前只有第一种（Regular Agent），而且所有子 Agent 平级、无分工、无通信。

### 2.3 六种内置 Agent 类型

| Agent 类型 | 工具集 | 模型 | 特点 |
|-----------|--------|------|------|
| `general-purpose` | 全部 | 继承 | 默认，全功能 |
| `Explore` | 只读（Read/Glob/Grep/WebSearch/WebFetch） | haiku（外）/ inherit（内） | 一键式，omitClaudeMd |
| `Plan` | 只读 | inherit | 一键式，omitClaudeMd |
| `verification` | 只读 + Bash（build/test/lint） | inherit | 后台运行，gate 控制 |
| `statusline-setup` | 特定 | — | 配置状态行 |
| `claude-code-guide` | 全部 | — | 内置指南 |

### 2.4 工具权限过滤是多级的

```
getAllBaseTools()
  → filterToolsByDenyRules()        // 全局 deny list
  → ALL_AGENT_DISALLOWED_TOOLS       // 所有子 Agent 禁用: Agent/TaskOutput/ExitPlanMode/...
  → CUSTOM_AGENT_DISALLOWED_TOOLS    // 自定义 Agent 额外禁用
  → ASYNC_AGENT_ALLOWED_TOOLS        // 异步 Agent 只能用白名单内的工具
  → Agent-specific allowlist         // 每个 Agent 定义里的 tools: ['Bash', 'Read']
```

**关键细节**：异步 Agent 的工具集被大幅缩减（只有约 15 个工具），因为它在后台跑，没有交互式权限审批。

### 2.5 Fork Agent 是最精巧的 cache 优化

Fork 模式构建子 Agent 的消息时，所有 tool_use 的结果用**相同的占位文本**（"Fork started — processing in background"），只最后一条 directive 文本不同。结果：
- N 个并行 fork 的前面部分字节完全相同 → 共享 Anthropic prompt cache
- 只有最后一个 text block 不同 → 仅支付增量 token 费用
- 父 Agent 立即返回，fork 全部后台跑，结果通过 `<task-notification>` 回收

### 2.6 Coordinator 模式的集群组织

```
Coordinator（主 Agent）
  │
  ├── Worker-1（只读搜索）──→ task-notification ──→ Coordinator 合成
  ├── Worker-2（只读搜索）──→ task-notification ──→
  ├── Worker-3（代码实现）──→ task-notification ──→ Coordinator 合成
  └── Worker-4（验证）    ──→ task-notification ──→
  
工作流: Research(parallel) → Synthesis(coordinator) → Implementation(workers) → Verification(workers)
```

Coordinator 的 system prompt 被完全替换为"你是协调者"的角色描述。Worker 的工具集被限制为异步白名单。Worker 间的通信通过 SendMessage 工具。

### 2.7 关键发现：CC 也没有解决"模型主动用 Agent"的问题

这是一个重要的**反面发现**——经过对 CC 系统提示词的完整搜索，在常规模式下，**CC 同样不会让模型主动大量派生 Agent**。

#### 各模式的"主动性"程度对比

| 模式 | 主动性 | 实际 prompt 内容 |
|------|--------|-----------------|
| **常规模式**（session-specific guidance） | 弱 | 一句话："Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed." |
| **Agent Tool 描述**（非 fork） | 弱 | "Launch multiple agents concurrently whenever possible"——但这只是工具描述，不在主系统提示词里 |
| **Agent Tool 描述**（fork 模式） | 中弱 | "If research can be broken into independent questions, launch parallel forks in one message." |
| **Coordinator 模式** | **强** | "Parallelism is your superpower. Launch independent workers concurrently whenever possible — don't serialize work that can run simultaneously and look for opportunities to fan out." |
| **Verification Agent** | **强制** | "The contract: when non-trivial implementation happens on your turn, independent adversarial verification must happen before you report completion." (硬规则，不是建议) |

#### 根因分析

1. **系统提示词主体对 Agent 沉默**：CC 的 "You are an interactive agent..." 身份段、做事段、工具使用段——这三个占系统提示词主体的部分，对 Agent 派生**只字不提**。Agent 相关指引只在 "Session-specific guidance" 的次要位置出现了一条。

2. **whenToUse 是被动匹配，不是主动触发**：每个 Agent 类型的 `whenToUse` 字段是给模型看的描述，模型只在"自己觉得匹配"时才会想到用。但 LLM 天然倾向走最短路径——自己做比 spawn Agent 更简单。

3. **负向指引多于正向**：Agent Tool 的描述里有详细的 "When NOT to use" 列表（不要用来读单个文件 / 搜 2-3 个文件 / 找类定义等），但对应的 "When to use" 却很笼统。

4. **Coordinator 模式是唯一的例外**——因为它的整个系统提示词被替换，"并行是你的超能力"成为了核心身份认同。但这需要用户主动开启 `CLAUDE_CODE_COORDINATOR_MODE=1`。

5. **唯一真正有效的模式是"硬规则"**：Verification agent 的 "the contract" 模式——不是建议、不是描述，而是**规则**："当发生 X 时，你必须 spawn Y"。这是唯一模型会无条件遵守的。

#### 对 Mycoder 的设计启示

这个发现意味着：**构建 Agent 集群机制和让模型主动用它，是两个独立的问题**。

| 问题 | CC 解决了吗 | Mycoder 怎么办 |
|------|------------|---------------|
| 构建集群机制 | ✅ 完整（五种模式） | 迭代二~四 |
| 让模型在用户要求时使用 | ✅ whenToUse + 工具描述 | 系统提示词里加 Agent 描述 |
| 让模型**主动**使用 | ❌ 只有 coordinator 模式做到了 | **需要硬规则** |

关键设计决策：不要让模型判断"该不该并行"——要么写硬规则（类似 verification contract），要么在引擎层面识别可并行任务并自动分派。后者正是管道模式里 **Orchestrate Stage** 的职责——引擎发现 N 个独立工具调用时，自动 spawn N 个 Agent 而不是自己做。

---

## 三、Mycoder vs Claude Code 差距矩阵

| 维度 | Mycoder (当前) | Claude Code | 差距 |
|------|---------------|-------------|------|
| **子 Agent 创建模式** | 1 种（Regular，平级，无分工） | 5 种（Regular/Fork/InProcess/tmux/Remote） | **大** |
| **Agent 角色定义** | 无——全靠 prompt 描述 | 6 个内置 + 自定义 Agent 定义（Markdown frontmatter） | **大** |
| **工具权限分配** | 全部 12 个工具 | 多级过滤（全局→自定义→异步→Agent 特定） | **中** |
| **Agent 间通信** | Task(direct) 单向 | SendMessage 双向 + 文件邮箱 + structured messages | **大** |
| **集群组织** | 平级无结构 | Coordinator→Worker 分层 + Team roster 持久化 | **大** |
| **上下文隔离** | 子 Agent 独立 messages | AsyncLocalStorage（InProcess）+ OS 进程（tmux） | 不需要（单用户） |
| **Prompt Cache 优化** | 无 | Fork 模式：字节级前缀共享 | 不需要（DeepSeek 无此 cache） |
| **Agent 生命周期** | spawn → run → complete/kill | register → progress → notify → evict → resume | **中** |
| **Agent 恢复** | 无 | resumeAgent：从磁盘转录重建 | 低优先级 |
| **工作副本隔离** | 无 | createAgentWorktree（git worktree） | 低优先级 |

---

## 四、实施计划

### 迭代一：工具执行解耦（最小可验证步）

**目标**：消除 `run()` 和 `runSubAgent()` 中重复的工具执行代码，验证解耦可行性。

**现状**：agent.ts 里两个方法各有一套 ~30 行的工具执行逻辑，核心逻辑完全相同，差异仅在于：
- run()：发 ProgressEvent 给 CLI 显示
- runSubAgent()：写 agentLoop 统计

**方案**（已在 [[plan-decouple-agent.md]] 详细设计）：

```typescript
private async executeToolCalls(
  toolUses: ToolUse[],
  opts?: {
    onProgress?: (e: ProgressEvent) => void;      // 主Agent：显示
    updateStats?: (name, summary, output) => void; // 子Agent：统计
  },
): Promise<void>
```

**改动量**：~60 行（一个私有方法），不改 run() 外部接口。

**验证**：
- [ ] 主 Agent 调工具 → 终端显示正常
- [ ] 子 Agent 调工具 → 静默，agentLoop 统计更新
- [ ] 工具执行异常 → 不崩
- [ ] 合并显示（Read ×4）→ 行为不变
- [ ] `npx tsc` 零错误

**不做的事**：不引入 AgentContext、不拆 Stage 文件、不改引擎外部接口。

---

### 迭代二：角色化 Agent（核心交付）

**目标**：引入 Agent 角色系统——借鉴 CC 的 6 个内置 Agent 类型，给 Mycoder 加角色定义。

#### 2.1 角色定义

```typescript
interface AgentRole {
  name: string;              // 'scout' | 'builder' | 'reviewer' | 'general'
  description: string;       // 给 LLM 看的描述（whenToUse）
  allowedTools: string[];    // 工具白名单
  disallowedTools?: string[];
  maxTurns?: number;         // 迭代上限
  systemPromptAddendum?: string;  // 追加到子 Agent 的 system prompt
  model?: string;            // 可选模型覆盖
}
```

#### 2.2 第一版四个角色

| 角色 | 工具 | 迭代上限 | 用途 |
|------|------|---------|------|
| **Scout** | WebSearch, WebFetch, Read, Glob, Grep | 8 | 搜索+调研，纯只读 |
| **Builder** | Bash, Write, Edit, Read, Glob, Grep | 15 | 写代码+执行 |
| **Reviewer** | Read, Glob, Grep, Bash(read-only) | 8 | 代码审查 |
| **General** | 全部 12 个工具 | 10 | 默认，全功能 |

#### 2.3 AgentTool 改动

`inputSchema` 新增 `role` 参数：

```typescript
const inputSchema = z.object({
  description: z.string(),
  prompt: z.string(),
  role: z.enum(['scout', 'builder', 'reviewer', 'general']).optional().default('general'),
  run_in_background: z.boolean().optional(),
});
```

`call()` 逻辑：根据 role 查角色定义 → 过滤工具池 → 传给 runSubAgent。

#### 2.4 工具过滤函数

```typescript
function filterToolsByRole(allTools: Tools, role: AgentRole): Tools {
  if (role.allowedTools.includes('*')) return allTools;
  const allowSet = new Set(role.allowedTools);
  return allTools.filter(t => allowSet.has(t.name));
}
```

**改动量**：
- 新增 `src/roles.ts`（~50 行，角色定义 + 过滤函数）
- 修改 `src/tools-v2/AgentTool/`（~30 行，加 role 参数 + 过滤逻辑）
- 修改 `src/agent.ts`（~10 行，buildSystemPrompt 注入角色信息）

**验证**：
- [ ] `Agent(role: 'scout', ...)` 只能调 WebSearch/WebFetch/Read/Glob/Grep
- [ ] `Agent(role: 'builder', ...)` 能调 Bash/Write/Edit 但不能调 Agent
- [ ] `Agent(role: 'general', ...)` 能调全部工具
- [ ] `npx tsc` 零错误

---

### 迭代三：Agent 间通信 + 集群组织（进阶）

**目标**：让多个 Agent 能够互相通信、协作完成任务。

#### 3.1 Agent 间通信

**方案**：复用并扩展现有的 `pendingInstruction` 机制，不引入新的 IPC：

```
Agent-A ──→ Agent(B).pendingInstruction = "请用这个结果继续" ──→ Agent-B 下轮 LLM 看到
```

但现在需要**双向**——子 Agent 也能通知主 Agent 或其他子 Agent：

```typescript
// task.ts 新增
interface TaskState {
  // ... 现有字段
  outbox: Array<{ targetId: string; content: string }>;  // 待发消息
}
```

主 Agent 的 `orchestrate()` (未来管道阶段) 在每个循环末尾：
1. 遍历所有 running task 的 outbox
2. 把消息投递到目标 task 的 `pendingInstruction`
3. 或投递到主 Agent 的 `pendingNotifications`

#### 3.2 集群角色

借鉴 CC 的 Coordinator 模式——但更轻量：

```
主 Agent（Coordinator）
  │
  ├── Scout-1（搜索主题 A）──→ 结果 ──→ Coordinator 合成
  ├── Scout-2（搜索主题 B）──→ 结果 ──→
  ├── Builder-1（实现模块 A）──→ 结果 ──→
  └── Reviewer-1（审查全部）  ──→ 结果 ──→
```

**不做的事**（明确排除）：
- 不实现多进程/远程 Agent（单用户不需要）
- 不引入文件邮箱（OS 文件系统通信）
- 不引入 Prompt Cache 优化（DeepSeek 无此特性）
- 不实现 Agent 恢复/resume（短会话不需要，需要时再加）

**改动量**：~150 行
- `src/task.ts`：TaskState 加 `outbox` 字段
- `src/tools-v2/TaskTool/`：加 `send` action
- `src/agent.ts`：orchestrate 阶段（管道化后）

---

### 迭代四（远期）：管道化正式解耦

**目标**：把 Think/Act/Orchestrate 三个阶段正式拆分为独立模块。

这是 [[pipeline-design.md]] 详细设计的内容，核心架构：

```
run() {
  while 25轮:
    ctx = thinkStage.execute(ctx)        // LLM 环节
    if ctx.done → return
    ctx = actStage.execute(ctx)          // 工具环节
    ctx = orchestrateStage.execute(ctx)  // 集群编排环节
}
```

每个环节是平等黑盒——接收公文包（AgentContext）、处理、还给引擎。此时**迭代一的 executeToolCalls() 自然成为 Act Stage 的核心**，**迭代三的出箱投递自然成为 Orchestrate Stage 的核心**。

---

## 五、实施优先级与依赖

```
迭代一（工具解耦）
  │  依赖：无
  │  产出：executeToolCalls() 私有方法
  │  价值：消除重复，验证解耦可行性
  ↓
迭代二（角色化 Agent）
  │  依赖：迭代一（非硬性，但建议先做）
  │  产出：AgentRole + filterToolsByRole + role 参数
  │  价值：首次实现工具权限差异化，子 Agent 角色分工
  ↓
迭代三（Agent 间通信）
  │  依赖：迭代二（角色系统是通信的前提）
  │  产出：TaskState.outbox + Task(send) + orchestrate 阶段
  │  价值：Agent 集群雏形——能互相通信、协作
  ↓
迭代四（管道化解耦）
  │  依赖：迭代一 + 迭代三
  │  产出：ThinkStage + ActStage + OrchestrateStage + AgentContext
  │  价值：引擎与环节解耦，独立测试、独立替换
```

---

## 六、已学习但明确不做的事

| CC 特性 | 不做原因 |
|---------|---------|
| Fork Agent（prompt cache 优化） | DeepSeek 无 Anthropic 级别的 prompt cache |
| In-Process Teammate（AsyncLocalStorage） | 单用户单进程，不需要上下文隔离 |
| Process Teammate（tmux/iTerm2） | 单用户不需要多终端 Agent |
| Remote Agent（CCR 云端） | 不需要远程执行 |
| 文件邮箱（teammateMailbox） | 过度设计，TaskState.outbox 更简单 |
| Agent 恢复（resumeAgent） | 短会话不需要，需要时再加 |
| Worktree 隔离 | 个人开发不需要 git worktree |
| Coordinator 模式完整版 | 太重（~560 行），取最小子集 |
| Stop 钩子系统 | 单人使用不需要自动化钩子 |
| 片段/微压缩/响应式压缩 | 上下文还不够大，等需要时再参考 |

---

## 七、参考文件索引

### 本地项目
- `Plan/pipeline/pipeline-design.md` — 管道模式架构设计
- `Plan/pipeline/plan-decouple-agent.md` — executeToolCalls 抽离详细方案
- `Plan/pipeline/plan-cluster-explore.md` — 角色化集群探索
- `Plan/pipeline/conversation-log.md` — 全量讨论记录
- `Plan/multi-agent-plan.md` — 方案 A（并行 Fork）+ 方案 B（Task 体系）

### Claude Code 源码分析
- `Plan/pipeline/claude-code-study/findings.md` — 执行机制完整研究（五层精妙机制 + 对比）
- `Plan/pipeline/claude-code-study/queryengine-analysis.md` — QueryEngine 外层详解
- `Plan/pipeline/claude-code-study/query-analysis.md` — query.ts 内层循环详解
- `Plan/pipeline/claude-code-study/helpers-analysis.md` — 辅助基础设施（权限/上下文/派生）

### Claude Code 源码关键文件
- `study/claude-code/claude-code-main/src/tools/AgentTool/AgentTool.tsx` — Agent 创建调度中心（1,397行）
- `study/claude-code/claude-code-main/src/tools/AgentTool/runAgent.ts` — 子 Agent 执行引擎（973行）
- `study/claude-code/claude-code-main/src/tools/AgentTool/forkSubagent.ts` — Fork 机制（210行）
- `study/claude-code/claude-code-main/src/tools/AgentTool/builtInAgents.ts` — 内置 Agent 注册（72行）
- `study/claude-code/claude-code-main/src/tools/AgentTool/loadAgentsDir.ts` — Agent 定义加载
- `study/claude-code/claude-code-main/src/tasks/LocalAgentTask/LocalAgentTask.tsx` — 异步 Agent 生命周期
- `study/claude-code/claude-code-main/src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx` — 进程内队友
- `study/claude-code/claude-code-main/src/coordinator/coordinatorMode.ts` — 协调者模式
- `study/claude-code/claude-code-main/src/utils/swarm/` — 多 Agent 集群工具
- `study/claude-code/claude-code-main/src/tools/SendMessageTool/SendMessageTool.ts` — Agent 间通信

### Notion 空间
- [my-coder — Claude Code 精简重构项目](https://app.notion.com/p/my-coder-Claude-Code-3af96a05cbb5810b8567c497479f852d) — 主页面
- [Agent系统设计与重构](https://app.notion.com/p/3b096a05cbb581b8a9a5fccd771b614a) — Phase 22-44
- [完整代码解析](https://app.notion.com/p/3b096a05cbb581e68711ca328dfa9173) — v0.5.0 源码
- [v0.5.0 源码解析](https://app.notion.com/p/3b296a05cbb5819c9990c2c933aade9d) — 五层架构

---

## 八、更新日志

| 日期 | 事件 |
|------|------|
| 2026-08-05 | 初始创建：Notion + 本地 + CC 源码全量调研 + 四迭代计划 |
