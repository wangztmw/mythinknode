# 计划：Agent 树状集群 —— 根/分支/叶三层结构

> **创建时间**：2026-08-05
> **灵感来源**：任务规划驱动的树状分解 + Claude Code Coordinator 的监督模型
> **前置条件**：agentLoop() 统一循环（已完成）

---

## 一、核心思想

不是"主 Agent 派活给子 Agent"。而是 **"根规划 → 分支监督 → 叶执行"** 的树状结构。

```
用户任务: "重构 config.ts 并写测试"
  │
  ▼
根 Agent（规划者）: 全工具，25轮
  职责: 理解任务 → 拆成2-3个分支 → 创建分支Agent → 等报告 → 综合回复用户
  │
  ├─→ 分支 Agent（监督者）: 只读 + Agent + AgentTeam，10轮
  │     职责: 不干活，只派叶Agent → 用 AgentTeam(list) 检查进度 → 收结果 → 向上汇报
  │     │
  │     ├─→ 叶 Agent: 只给必需工具，3-5轮
  │     ├─→ 叶 Agent: 只给必需工具，3-5轮
  │     └─→ 叶 Agent: 只给必需工具，3-5轮
  │
  ├─→ 分支 Agent（监督者）
  │     └─→ ...更多叶Agent
  │
  └─→ 分支 Agent（监督者）
        └─→ ...更多叶Agent
```

**三层角色**：

| 层 | 角色 | 工具 | 轮次 | 职责 |
|----|------|------|------|------|
| 根 | Planner | 全部 | 25 | 分析→分解→创建分支→收报告→综合→回复用户 |
| 分支 | Supervisor | 只读+Agent+AgentTeam | 10 | 派叶节点→AgentTeam监督→收结果→向根汇报 |
| 叶 | Worker | 只看任务需要 | 3-5 | 干一件具体的事→返回结果→销毁 |

---

## 二、为什么是三层而不是两层

**两层的问题**（当前"主→子"模型）：
- 主 Agent 既要分析任务又要监督执行，认知负载太高
- 子 Agent 干完直接返回，没有中间检查点
- 主 Agent 不知道子 Agent 是"快完成了"还是"卡住了"

**三层的优势**：
- **认知分离**：根只管"做什么"，分支只管"做完了没"，叶只管"怎么做"
- **中间检查**：分支是专职监督者——它不需要自己干活，只需要盯着叶节点是否完成
- **容错**：叶节点死了，分支可以重新派一个。根不需要知道这个细节
- **和 Claude Code Coordinator 一致**：Coordinator 就是根+分支的合体——它既规划又监督。三层只是把这个职责拆开了

---

## 三、每层的具体行为

### 3.1 根 Agent（Planner）

```
输入: 用户任务 "重构 config.ts 并写测试"

第1轮: Read config.ts → 理解现有代码
第2轮: Grep 引用 → 了解依赖
第3轮: 规划 → "这个任务可以分成3个分支：
         分支1: 调研所有引用点
         分支2: 执行重构
         分支3: 写测试验证"
第4轮: 同时创建3个分支Agent（background=true）
       → Agent(description="调研引用", type="supervisor", ...)
       → Agent(description="执行重构", type="supervisor", ...)
       → Agent(description="写测试",  type="supervisor", ...)

第5轮: AgentTeam(list) → 检查分支进度
第6轮: AgentTeam(list) → 分支1完成，分支2运行中
第7轮: AgentTeam(check) 读分支1报告 → 先理解调研结果
第8轮: 等全部分支完成 → AgentTeam(check) 读报告
第9轮: 综合 → 回复用户 "重构完成。改动3个文件，测试通过。"
```

### 3.2 分支 Agent（Supervisor）

```
输入: 根Agent的指令 "执行重构：改 loadConfig 和 saveConfig 加缓存"

第1轮: 理解任务 → 拆成具体步骤
       → Agent(description="改loadConfig",  type="worker", tools=[Read,Write], maxRounds=3)
       → Agent(description="改saveConfig",  type="worker", tools=[Read,Write], maxRounds=3)
       → Agent(description="验证编译",      type="worker", tools=[Bash],    maxRounds=3)

第2轮: AgentTeam(list) → 三个worker运行中
第3轮: AgentTeam(list) → 前两个完成，第三个还在跑
第4轮: AgentTeam(check) 读前两个结果 → 确认改动正确
第5轮: 第三个完成 → AgentTeam(check) → 编译通过 ✓

→ 向根Agent汇报: "重构完成。loadConfig/saveConfig 改动正确，tsc编译通过。"
```

**分支 Agent 的工具限制**：
- Read/Glob/Grep —— 读结果、检查代码
- Agent —— 创建叶节点
- AgentTeam —— 监督叶节点进度
- **不给** Write/Edit/Bash —— 自己不写代码，只监督

### 3.3 叶 Agent（Worker）

```
输入: 分支Agent的指令 "改 loadConfig(): 在函数开头加缓存检查"

第1轮: Read config.ts → 看到当前代码
第2轮: Edit loadConfig → 加缓存逻辑
第3轮: end_turn → "loadConfig 缓存已添加，改动了第10-15行"

→ 返回给分支Agent → 销毁
```

**叶 Agent 的工具**：由分支 Agent 决定给什么。通常只有 2-4 个工具——刚好够完成任务。不给 Agent 工具（叶节点不能再分派）。

---

## 四、Agent 类型定义

```typescript
type AgentRole = 'planner' | 'supervisor' | 'worker';

interface AgentRoleConfig {
  role: AgentRole;
  maxDepth: number;        // planner=0, supervisor=1, worker=2
  defaultMaxRounds: number; // planner=25, supervisor=10, worker=5
  defaultTools: string[];  // 默认工具。supervisor/worker 由调用者覆盖
  canSpawnSubAgents: boolean;  // planner=true, supervisor=true, worker=false
}
```

**在 AgentTool 的 `call()` 中**：如果是 `supervisor` 类型 → 创建时自动给 Agent+AgentTeam 工具。如果是 `worker` 类型 → 不给 Agent 工具。递归在此截断。

---

## 五、和当前 agentLoop 的关系

当前 `agentLoop()` 已经是统一的循环——主 Agent 和子 Agent 都用它。这是树状模型的基础：

```
根 Agent:    agentLoop(engine, { messages: sessionMessages, maxRounds: 25, tools: ALL, ... })
分支 Agent:  agentLoop(engine, { messages: local, maxRounds: 10, tools: SUPERVISOR_TOOLS, ... })
叶 Agent:    agentLoop(engine, { messages: local, maxRounds: 5,  tools: [Read,Write], ... })
```

**不用改 agentLoop()。** 树状模型只是 agentLoop 的不同配置——和 Claude Code 的 queryLoop 一样，配置决定行为。需要新增的是 AgentTool 对 `supervisor`/`worker` 类型的支持，以及递归深度检查。

---

## 六、需要新增/修改的文件

| 文件 | 改动 |
|------|------|
| `src/tools-v2/AgentTool/AgentTool.ts` | `subagent_type` 枚举加 `'supervisor'` 和 `'worker'`。supervisor 默认给 Agent+AgentTeam 工具。worker 不给 Agent 工具 |
| `src/session_loop.ts` | `AgentLoopParams.tools` 参数（已有计划）。不传用全部，传了用传入的 |
| `src/tools-v2/AgentTeamTool/AgentTeamTool.ts` | list 增强——显示 Agent 角色和深度 |
| `src/agent_team.ts` | `MemberState` 加 `role` 和 `depth` 字段 |
| 系统提示词 | 加树状结构的协作指引 |

**不改**：agentLoop()、agent_def.ts、cli.ts、Mycoder.ts

---

## 七、实施顺序

1. **`AgentLoopParams.tools` 参数**：agentLoop 支持传入工具子集（主 Agent 不传，子 Agent 传过滤后的）
2. **`MemberState` 加 `role`/`depth`**：记录每个 Agent 的角色和深度
3. **AgentTool 支持 `supervisor`/`worker` 类型**：自动分配工具和轮次
4. **系统提示词更新**：告诉 LLM 三层结构怎么用
5. **验证**：端到端测试——一个复杂任务被正确拆解为根→分支→叶

---

## 八、验证清单

| # | 场景 | 期望 |
|---|------|------|
| 1 | 简单任务（"读 README"） | 根直接调 Read 完成，不创建分支 |
| 2 | 复杂任务（"重构+测试"） | 根创建 2-3 个分支，分支各自创建叶节点 |
| 3 | 分支监督 | 分支通过 AgentTeam(list) 检查叶节点进度 |
| 4 | 叶节点完成 | 叶节点返回结果 → 分支收报告 → 向上汇报 |
| 5 | 递归深度限制 | worker 类型不能创建孙 Agent |
| 6 | 工具收窄 | supervisor 不拿 Write/Edit，worker 只拿任务需要的工具 |
