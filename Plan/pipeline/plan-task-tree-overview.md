# 任务树系统 — 实施总览

> **核心理念**：所有任务树代码集中在 `src/task_tree/` 一个文件夹内，由 `agentLoop`（session_loop.ts）统一调用入口。现有文件最小改动，新增功能模块化。

---

## 一、文件变动全景

### 新增（1 个文件夹，8 个文件）

```
src/task_tree/                    ← 所有任务树逻辑集中在此
  types.ts         (~130行)      类型定义（TreeNode, TaskTree, LoopResult, ITreeAgentBridge, WalEntry, TreeDelta...）
  core.ts          (~180行)      树的基础操作（create/addChild/replaceSubtree/dispatch/report/checkStatus/renderTree）
  lock.ts          (~100行)      TreeWriteLock（进程内 Promise 队列互斥锁）
  wal.ts           (~160行)      WAL 预写日志（append/replay/compact/cleanOldWals）
  cascade.ts       (~80行)       级联终止 + 孤儿结果收集
  validate.ts      (~140行)      分解校验 + 引用验证 + 自动修复
  persist.ts       (~150行)      saveTree/loadTree/delta/archive/cleanOldTrees
  context.ts       (~100行)      上下文控制（截断/摘要/状态分级）
  file_tracker.ts  (~130行)      文件追踪 + 发散检测 + 文件锁
  resume.ts        (~120行)      会话恢复编排
```

**合计：~1,290 行，每个文件单一职责、可独立测试。**

### 修改（8 个现有文件）

| 文件 | 改动量 | 改动内容 |
|------|--------|---------|
| `session_loop.ts` | +35/-5 | agentLoop 返回 `LoopResult`；支持 `agentMeta`/`fileTracker`/`treeNodeId` 参数；preRoundCheck 硬 break blocked |
| `agent_def.ts` | +20/-5 | `buildSystemPrompt` 按角色分层（Planner/Supervisor/Worker）；动态内容移出 system prompt；`AgentEngine` 加 `activeTreeId`/`setActiveTree` |
| `agent_team.ts` | +8/-2 | `MemberState` 加 `treeNodeId`/`treeRole`/`depth`/`contextFiles`；`addMember` 支持 `parentDepth`；`completeMember` 通过 bridge 同步树 |
| `tools-v2/AgentTool/AgentTool.ts` | +50/-10 | depth 检查；isLeaf 时去 Agent 工具；context.files 冲突检测；结构化返回处理；preRoundCheck 增强 |
| `tools-v2/AgentTeamTool/AgentTeamTool.ts` | +30/-5 | 三级状态分级（list/check/deep）；发散警告显示；通过 TreeEvent 消费状态 |
| `tools-v2/index.ts` | +2 | 注册 TreeCmdTool |
| `Mycoder.ts` | +20/-2 | 启动流程加树恢复、WAL 初始化、bridge 注入 |
| `session.ts` | +10 | `SessionData` 加 `treeId`/`fileLocks`；`lockSession` 支持 `treeId` |
| `cli/cli.ts` | +5/-2 | 适配 agentLoop 新返回类型 `LoopResult` |

### 新增工具（1 个）

| 文件 | 内容 |
|------|------|
| `tools-v2/TreeCmdTool/TreeCmdTool.ts`（~120行） | 树操作工具：create/add_child/status/report/replace/get_leaves |
| `tools-v2/TreeCmdTool/prompt.ts`（~5行） | 工具描述 prompt |

---

## 二、调用关系

```
Mycoder.ts (启动)
  │
  ├─ 初始化 task_tree 模块（loadTree, initWal, TreeWriteLock）
  ├─ 注入 ITreeAgentBridge（解决循环依赖）
  ├─ resumeSessionOrchestrator() → 恢复上次会话的树 + WAL 回放
  │
  └─ agentLoop(engine, params) ←───────────────── 主循环入口
       │
       ├─ preRoundCheck ←─ resume.ts 提供（按需推送树事件）
       │   ├─ 检测级联终止信号
       │   ├─ 检测 completed/failed/blocked 事件
       │   └─ 正常返回 null（零上下文注入）
       │
       ├─ executeTools ←─ file_tracker.ts hook（收集文件操作）
       │
       ├─ callLLM → LLM 返回 tool_use → AgentTool.call()
       │    │
       │    └─ AgentTool.call()
       │         ├─ depth 检查 ←─ cascade.ts
       │         ├─ isLeaf → 去 Agent 工具
       │         ├─ context.files 冲突检测 ←─ file_tracker.ts
       │         └─ 创建子 agentLoop → 返回 LoopResult
       │              │
       │              └─ 子 agentLoop 内部:
       │                   ├─ preRoundCheck（级联终止感知）
       │                   ├─ Worker 自检标记 [CHECKLIST]+[DONE]/[PARTIAL]/[BLOCKED]
       │                   └─ 返回 LoopResult → AgentTool 按 status 分支处理
       │
       └─ 返回 LoopResult → cli.ts 解包 text 显示
```

---

## 三、各文件改动详解

### 3.1 session_loop.ts（核心入口，+35/-5 行）

**改什么**：agentLoop 是任务树的唯一调用入口。新增三个可选参数，返回类型从 `string` 改为 `LoopResult`。

```typescript
// 参数扩展
interface AgentLoopParams {
  messages: ChatMessage[];
  maxRounds: number;
  // ... 现有回调不变
  serialTools?: boolean;

  // ★ 新增三个参数
  agentMeta?: { depth: number; isLeaf: boolean };    // 当前 Agent 的树角色
  fileTracker?: (toolName: string, input: Record<string, unknown>) => void;  // 文件追踪 hook
  treeNodeId?: string;                                // 关联的树节点 ID
}

// ★ 返回类型变更（单向门——破坏性变更，但影响面仅 2 处调用点）
type LoopStatus = 'success' | 'max_rounds' | 'killed' | 'blocked' | 'crashed';
interface LoopResult { status: LoopStatus; text: string; blockedReason?: string; }
async function agentLoop(engine, params): Promise<LoopResult>;
```

**功能变化**：
- agentLoop 不再返回裸 string。调用者（cli.ts、AgentTool.ts）根据 `status` 区分正常完成/max rounds/被 kill/被 block/崩溃
- `agentMeta` 传入后，agentLoop 根据角色控制行为（Worker 不可 spawn、Supervisor 可 spawn Worker 等）
- `fileTracker` hook 在每个工具执行时自动记录文件操作
- preRoundCheck 增加硬逻辑：返回 `"blocked:..."` 时直接 break 返回 `{status:'blocked'}`
- preRoundCheck 返回 `"(killed)"` 时返回 `{status:'killed'}`

### 3.2 agent_def.ts（引擎配置，+20/-5 行）

**改什么**：`buildSystemPrompt` 按 Agent 角色分层构建，动态内容移出 system prompt。

```typescript
class AgentEngine {
  activeTreeId: string | null = null;
  activeTreeNodeId: string | null = null;
  setActiveTree(treeId: string, nodeId?: string): void;
  getTreeContext(): string | null;
}

// buildSystemPrompt 按角色分层
function buildSystemPrompt(role?: 'planner' | 'supervisor' | 'worker'): string;
// Planner: 树操作指引 + 义群约束 + 收敛规则（~350 tokens）
// Supervisor: 冲突处理 + Worker 二次验证指引 + 收敛规则（~180 tokens）
// Worker: 自检标记 + isLeaf 判断标准 + 收敛规则（~60 tokens）
// 未指定 role → 沿用现有 prompt（向后兼容）

// ★ 收敛规则（所有角色都注入）：
// "你可以继续分解任务创建子树，直到义群不可再分（isLeaf=true）。
//  收敛由语义决定，不是由深度决定。判断标准：
//  - 该义群只涉及 1-2 个文件且只改 1 个概念 → isLeaf=true
//  - 该义群是一个原子 Git commit → isLeaf=true
//  - 该义群可以继续拆成更小的独立操作 → isLeaf=false，继续分解"
```

**功能变化**：
- 每种角色只看到自己需要的指引，不会膨胀
- CWD/Date 移到首条 user message，system prompt 变为纯静态（可被 prompt cache 命中）
- Supervisor prompt 含二次验证："不要仅凭 Worker 的 [DONE] 判断完成，至少用 Read 确认文件改动存在"
- **收敛由 LLM 语义判断 + isLeaf + 总节点数断路，不硬限深度**

### 3.3 agent_team.ts（注册表，+8/-2 行）

**改什么**：`MemberState` 加树相关字段，`addMember` 支持深度参数。

```typescript
interface MemberState {
  // ... 现有字段不变
  treeNodeId?: string;           // ★ 反向链接到 TreeNode.id
  treeRole?: 'planner' | 'supervisor' | 'worker';  // ★ Agent 在树中的角色
  depth: number;                  // ★ 0/1/2
  contextFiles?: string[];        // ★ 该 Agent 将操作的文件
}

function addMember(type, subject, desc?, parentDepth?: number): MemberState;
// parentDepth: 父 Agent 的深度，当前 Agent 深度 = parentDepth + 1
```

**功能变化**：
- `completeMember` 扩展：如果 member 有 `treeNodeId`，通过 `ITreeAgentBridge` 同步树节点状态
- `addMember` 自动计算并记录 depth
- 不破坏现有 `team` Map 的操作语义

### 3.4 AgentTool.ts（子 Agent 创建，+50/-10 行）

**改什么**：子 Agent 创建前增加收敛检查、冲突检测、结构化返回处理。

```typescript
// inputSchema 新增字段
context_files: z.array(z.string()).optional()  // 声明要操作的文件
parent_depth: z.number().optional()            // 父 Agent 深度（仅用于记录，不做硬限制）

// call() 内部新增流程:
async call({..., context_files, parent_depth}, _ctx) {
  // 1. 收敛检查（不是深度限制）：
  //    检查整棵树的节点总数 >= MAX_NODES(50) → blocked（电路断路器）
  //    检查 isLeaf 标记：如果父节点标记了 isLeaf，LLM 不应该再创建子节点
  //       → 如果 LLM 仍然尝试，返回提示"该节点已标记为叶节点，请直接执行"
  //    没有深度硬限制——子 Agent 可以继续分解，把子树挂到原树上
  // 2. context.files 冲突检测: acquireFileLock → 冲突 → blocked + notify
  // 3. 身份声明注入首条 user message（role + isLeaf 标记）
  // 4. preRoundCheck 增强版（按需推送 + 级联感知）
  // 5. 根据 agentLoop 返回的 LoopResult.status 分支处理:
  //    success → completeMember
  //    blocked → 标记 blocked
  //    killed → 标记 killed
  //    max_rounds/crashed → 标记 failed
}
```

**功能变化**：
- 子 Agent 可以继续 spawn 子 Agent——深度由任务复杂度决定，不设硬上限
- Agent 工具不被移除——LLM 通过 isLeaf 自主判断是否继续分解
- 文件冲突自动检测（和 running Agent 的 contextFiles 取交集）
- 子 Agent 完成任务时自动同步树节点状态
- 崩溃/超时子 Agent 正确标记为 failed（不再误标 completed）

### 3.5 AgentTeamTool.ts（团队管理，+30/-5 行）

**改什么**：三级状态分级，发散警告显示。

```typescript
// list 模式: 紧凑每节点 1 行（~20 token/节点），以 TreeEvent 为数据源
// check 模式: 完整状态 + 结果摘要 + 文件发散警告
// deep 模式: 整棵子树完整展开（含完整 result）

// ★ 新增：check 模式输出中加入发散信息
if (divergence.isDivergent) {
  result += `\n⚠ Tree divergence: Missed=${divergence.missed}, Untouched=${divergence.untouched}`;
}
```

**功能变化**：
- list 输出从冗长列表变为紧凑状态图标（20 token/节点 vs 之前 150 token/节点）
- check 增加文件发散检测信息
- 通过 TreeEvent 消费树状态，不直接 loadTree

### 3.6 TreeCmdTool.ts（新工具，+125 行）

**改什么**：新增专用树操作工具。

```typescript
// 独立工具，不与 AgentTeam 混合
const inputSchema = z.object({
  action: z.enum(['create', 'add_child', 'status', 'report', 'replace', 'get_leaves']),
  treeId: z.string().optional(),
  parentId: z.string().optional(),
  nodeId: z.string().optional(),
  meaning: z.string().optional(),
  task: z.string().optional(),
  role: z.enum(['planner', 'supervisor', 'worker']).optional(),
  result: z.string().optional(),
  purpose: z.string().optional(),
});
```

**功能变化**：
- LLM 通过 TreeCmd 工具管理树结构（建树、加子节点、查状态、汇报结果、替换子树、获取可执行叶节点）
- 与 AgentTeam 职责分离：AgentTeam 管 Agent 生命周期，TreeCmd 管 TreeNode 结构

### 3.7 Mycoder.ts（启动入口，+20/-2 行）

**改什么**：启动时初始化树模块、注入依赖、触发恢复。

```typescript
async function main() {
  // ... 现有初始化
  cleanOldMembers();    // 已有
  cleanOldTrees();      // ★ 新增
  cleanOldWals();       // ★ 新增

  // ★ 注入 ITreeAgentBridge（解决 task_tree ↔ agent_team 循环依赖）
  initTreeBridge({ getMember, completeMember, onTreeNodeSynced });

  // ★ 如果有 --resume 且未完成会话存在
  if (shouldResume && hasUnfinishedSession()) {
    resumeSessionOrchestrator(engine);  // loadTree → replayWal → detectLostAgents → 注入摘要
  }

  // ... startCLI → agentLoop
}
```

**功能变化**：
- 启动时自动清理过期树文件（7 天）
- 启动时注入依赖桥接
- 会话恢复自动加载未完成的树、回放 WAL、修复崩溃节点

### 3.8 session.ts / cli.ts（小改动）

**session.ts**：`SessionData` 加 `treeId`/`fileLocks` 字段，`lockSession` 支持记录 treeId。
**cli.ts**：`agentLoop` 返回 `LoopResult` 后解包 `result.text` 显示。

---

## 四、收敛机制（替代 depth 硬限制）

### 设计原则

**深度由语义决定，不由代码截断。** 每个 Agent 可以继续分解自己的义群，把子树挂到原树上——递归直到 `isLeaf: true`。收敛来自四个层次的配合：

### 四层收敛

```
第一层：语义自然终止（LLM 自主）
  ┌─────────────────────────────────────────────┐
  │ LLM 判断 isLeaf 的三个标准（注入 system prompt）: │
  │  1. 只涉及 1-2 个文件 + 1 个概念 → isLeaf=true │
  │  2. 是一个原子 Git commit → isLeaf=true        │
  │  3. 可以拆成更小的独立操作 → isLeaf=false      │
  │  isLeaf=true → 直接执行，不继续分解             │
  │  isLeaf=false → 调用 TreeCmd(add_child) 建子树 │
  └─────────────────────────────────────────────┘

第二层：质量门禁（validateDecomposition）
  ┌─────────────────────────────────────────────┐
  │ 校验 LLM 产出的 TaskDecomposition:            │
  │  - 空义群检测（context.files 为空 → 合并回父级） │
  │  - 过度重叠检测（Jaccard > 0.8 → 警告）       │
  │  - 循环依赖检测（A 依赖 B 且 B 依赖 A → 拒绝） │
  │  - 交叉校验（parallelism 引用必须在 groups 中） │
  │  连续 2 次校验不通过 → fallback 单义群        │
  └─────────────────────────────────────────────┘

第三层：电路断路器（MAX_NODES=50）
  ┌─────────────────────────────────────────────┐
  │ 整棵树节点总数上限 50。超限 → 拒绝添加，       │
  │ 提示 LLM: "任务过于复杂，请合并相关义群"       │
  │ 这不是"出错"，是"任务超出了合理复杂度范围"     │
  └─────────────────────────────────────────────┘

第四层：安全攻击检测
  ┌─────────────────────────────────────────────┐
  │ 检测异常模式（非正常分解，可能是 prompt 攻击）: │
  │  - 同一义群 Jaccard > 0.9 连续 3 次分解 → 标记 │
  │  - 单节点 replanCount > 3 → 上报父节点        │
  │  - 空义群连续出现 → 标记异常并通知用户         │
  │  触发任一条 → 通知 LLM + 记录异常日志          │
  └─────────────────────────────────────────────┘
```

### 示例：正常的多层分解

```
深度0: 根 Agent "重构认证系统" (isLeaf=false)
  ├─ 深度1: Supervisor "重构 OAuth 模块" (isLeaf=false)
  │   ├─ 深度2: Worker "改 OAuth token 刷新逻辑" (isLeaf=false → 继续拆)
  │   │   ├─ 深度3: Worker "改 refreshToken() 函数签名" (isLeaf=true)
  │   │   ├─ 深度3: Worker "改 token 过期处理" (isLeaf=true)
  │   │   └─ 深度3: Worker "更新调用点" (isLeaf=true)
  │   └─ 深度2: Worker "写 OAuth 测试" (isLeaf=true)
  ├─ 深度1: Supervisor "重构密码模块" (isLeaf=true → 直接执行)
  └─ 深度1: Supervisor "重构会话模块" (isLeaf=false)
      └─ 深度2: Worker "改 session store" (isLeaf=true)
```

深度到了 3 层，总节点数 9，完全正常。如果硬 limit depth=2，OAuth 模块的细化分解就被截断了。

---

## 五、功能变化总结

### 对用户可见的变化

| 功能 | 变化 |
|------|------|
| **复杂任务自动建树** | LLM 调用 TaskDecompose → 一次结构化输出产出义群树 → 存入 `~/.mycoder/trees/` |
| **递归分解** | Agent 可继续分解自己的义群，子树挂到原树上，深度由任务复杂度自然决定 |
| **并行执行** | 独立义群自动并行派发，根 Agent 通过 AgentTeam list 监控 |
| **崩溃恢复** | 重启后自动加载未完成的树 + WAL 回放 + 修复丢失节点 → 注入 LLM 上下文 |
| **`mycoder tree` 命令** | 可视化当前/历史任务树（ASC-II 树状图） |
| **AgentTeam 更简洁** | list 输出紧凑（每节点 1 行），需要详情再用 check |
| **TreeCmd 新工具** | 专门管理树结构：create/add_child/status/report/replace/get_leaves |

### 对开发者可见的变化

| 变化 | 说明 |
|------|------|
| agentLoop 返回 `LoopResult` | 不再是裸 string。包含 status 区分正常/异常/blocked/killed |
| MemberState 加树字段 | treeNodeId/treeRole/depth/contextFiles，向后兼容 |
| system prompt 按角色分层 | Planner/Supervisor/Worker 各自加载，收敛规则注入所有角色 |
| task_tree/ 文件夹 | 所有树逻辑集中一处，每个文件 < 200 行 |
| ITreeAgentBridge 依赖反转 | 启动时注入，解决循环依赖 |
| 四层收敛机制 | 语义自然终止 → 质量门禁 → 电路断路器 → 安全攻击检测 |

### 不变的

- agentLoop 主循环逻辑不变（for 循环、callLLM、executeTools、pushResults）
- 现有 12 个工具全部不变
- agent_team 的 Map + 磁盘持久化模式不变
- CLI REPL 交互模式不变
- ConcurrencyLimiter(3) 不变
- npm 发布流程不变

---

## 六、总代码量

| 类别 | 行数 |
|------|------|
| 新建 `src/task_tree/`（10 文件） | ~1,290 |
| 新建 `src/tools-v2/TreeCmdTool/`（2 文件） | ~125 |
| 现有文件修改（8 文件） | ~180（净增） |
| **合计** | **~1,595 行** |
| 当前代码量 | ~3,255 行 |
| 实施后 | ~4,850 行（+49%） |

每个新建文件平均 130 行，每个修改文件平均 +22 行。无单文件膨胀问题。
