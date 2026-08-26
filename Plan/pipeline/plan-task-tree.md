# 计划：任务树系统 — 语义驱动的层次化 Agent 集群

> **创建时间**：2026-08-06
> **前置**：agentLoop() 统一循环 + agent_team 共享白板 + 双向反馈
> **新建文件**：`src/task_tree.ts`（~250行）

---

## 一、三遍思考（融合为一次 LLM 调用）

不是三次独立调用。是**一次结构化输出**，三个字段：

```typescript
interface TaskDecomposition {
  purpose: string;           // "重构 config.ts 缓存逻辑，测试，更新文档"
  parallelism: {             // 时空并行性分析
    independent: string[][]; // 可并行执行的义群组
    sequential: string[][];  // 必须串行的义群组
    reason: string;           // 为什么这样分
  };
  groups: MeaningGroup[];    // 按动作划分的独立义群
}

interface MeaningGroup {
  meaning: string;           // 语义描述："重构缓存逻辑"
  context: {                 // 涉及的文件/概念
    files: string[];
    concepts: string[];
  };
  subGroups?: MeaningGroup[]; // 子树（叶节点没有）
  isLeaf: boolean;           // 是否不可再分
}
```

**一次调用，三个字段全部产出。** LLM 先理解 purpose → 再分析哪些能并行 → 再拆成义群。

---

## 二、建树阶段（理解） + 执行阶段（干活）

### 建树阶段

```
用户: "重构 config.ts 的缓存逻辑，然后写单元测试，并更新 README"
  │
  ▼
Root Agent: Read config.ts → Grep imports → TaskDecompose
  → purpose: "重构config.ts缓存+测试+文档"
  → parallelism: { independent: [["缓存逻辑","README更新"]],
                    sequential: [["测试"必须在"重构"之后]] }
  → groups: [
      { meaning: "重构缓存逻辑", context: {files:["config.ts"], concepts:["caching"]} },
      { meaning: "编写测试",     context: {files:["config.test.ts"], concepts:["testing"]} },
      { meaning: "更新README",  context: {files:["README.md"], concepts:["docs"]} },
    ]

  → 缓存逻辑太复杂 → 拆子义群 → 派子Agent
    → 子Agent 继续分解缓存逻辑 → 返回子树
  → 测试可拆子义群 → 派子Agent
    → 子Agent 继续分解测试 → 返回子树
  → README更新很简单 → 直接标记为叶节点

  → 根Agent 收到所有子树 → 组装完整任务树
  → saveTree() → ~/.mycoder/trees/{session-id}.json
```

**关键设计**：义群分解是递归的。每个 Agent 只负责自己那一层。不是根一次性想好整棵树。

### 执行阶段

```
Root Agent:
  读树 → checkSubtreeStatus()
  → 所有子节点 pending → dispatch 可以并行的分支
  → 等分支完成 → reportResult()
  → 叶节点失败 → replaceSubtree() → 重新分解

Branch Agent:
  读自己的子树 → getExecutableLeaves()
  → dispatch workers
  → AgentTeam(list) 监督
  → 收集结果 → reportResult() → 返回 Root
```

---

## 三、树数据结构

```typescript
interface TreeNode {
  id: string;                    // "n-k3jf92a1"
  parentId: string | null;       // null = 根节点
  meaning: string;               // 语义描述 ("重构缓存逻辑")
  context: {                     // 碰了哪些东西
    files: string[];             //   ["config.ts", "config.test.ts"]
    concepts: string[];          //   ["caching", "roundtrip"]
  };
  task: string;                  // 具体任务提示词
  role: 'planner' | 'supervisor' | 'worker';
  status: 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'killed';
  assignedAgentId: string | null; // agent_team MemberState.id
  depth: number;                  // 0=root, 1=branch, 2=leaf
  maxRounds: number;
  tools: string[] | null;        // null=用角色默认值
  result: string | null;
  replanCount: number;           // 重新分解次数
  children: string[];            // 子节点ID列表（冗余，加速遍历）
}

interface TaskTree {
  sessionId: string;
  rootId: string;
  nodes: Record<string, TreeNode>;  // 扁平Map, O(1)查找
  createdAt: number;
  updatedAt: number;
  version: number;
}
```

**存储**：`~/.mycoder/trees/{session-id}.json`，原子写入(tmp+rename)。

**子树替换**：叶节点失败 → `replaceSubtree()` 删除旧子树 → 新建替换 → `version++`。

---

## 四、文件变化

| 文件 | 变化 | 行数 |
|------|------|------|
| `src/task_tree.ts` | **新文件**：TreeNode/TaskTree类型 + createTree/addChild/replaceSubtree/dispatch/report/checkStatus/getLeaves/renderTree | ~250 |
| `src/agent_team.ts` | `MemberState` 加 `treeNodeId`/`role`/`depth` | +3 |
| `src/tools-v2/AgentTool/AgentTool.ts` | `subagent_type` 加 `'planner'`/`'supervisor'`/`'worker'` | +5 |
| `src/session.ts` | `SessionData` 加 `treeId` | +1 |
| `src/agent_def.ts` | system prompt 加任务树指引 | +5 |

新增 250 行 + 改动 14 行。不改 agentLoop/session_loop/cli。

---

## 五、与现有代码的桥接

```
AgentTool (改):
  subagent_type: 'general-purpose' | 'explore' | 'planner' | 'supervisor' | 'worker'
  'planner' = 所有工具, 25轮
  'supervisor' = [Read,Glob,Grep,Agent,AgentTeam], 10轮
  'worker' = 调用者指定, 5轮, 不可创建子Agent

agent_team.ts (改):
  MemberState.treeNodeId → 链接到 TreeNode
  MemberState.role → planner/supervisor/worker
  MemberState.depth → 0/1/2

task_tree.ts (新):
  所有树操作 → createTree/addChild/replaceSubtree/dispatch/report/checkStatus
  → 读写 ~/.mycoder/trees/{session-id}.json
  → 被 AgentTool 和 agentLoop 调用
```

**调用关系**：

```
Root Agent's agentLoop:
  第N轮: LLM 调用 TaskDecompose → 解析JSON
    → createTree() → addChildNode() × N
    → 每个 branch: Agent(subagent_type='supervisor', ...)

Branch Agent's agentLoop:
  第N轮: LLM 调用 TaskDecompose → 解析JSON
    → addChildNode() × N
    → 每个 leaf: Agent(subagent_type='worker', tools=[...])

Leaf Agent's agentLoop:
  干活 → reportResult() → 反馈 → 销毁
```

---

## 六、mycoder tree 命令

```bash
mycoder tree                    # 当前会话的ASC-II任务树
mycoder tree <session-id>       # 历史会话的任务树
mycoder tree --json             # 原始JSON
```

输出示例：
```
● 重构 config.ts 缓存逻辑
   ├─ ✓ 调研引用点
   │     ├─ ✓ Grep loadConfig
   │     └─ ✓ Grep saveConfig
   ├─ ● 执行重构
   │     ├─ ✓ 改loadConfig
   │     ├─ ◌ 改saveConfig
   │     └─ ◐ 编译验证 (blocked: tsc not found)
   └─ ◌ 写测试
```

---

## 七、验证清单

| # | 场景 | 期望 |
|---|------|------|
| 1 | LLM TaskDecompose 结构化输出 | 正确解析三个字段 |
| 2 | 简单任务（"读README"） | 直接执行，不建树 |
| 3 | 中复杂任务（"重构一个文件"） | 建树 → 根规划 → 1-2个分支 |
| 4 | 复杂任务（"重构+测试+文档"） | 建树 → 3个分支并行 → 各自再分解 |
| 5 | 叶节点失败 → 反馈 → 重构子树 | replaceSubtree 正确删除旧节点 |
| 6 | 树保存/加载 | atomic write + JSON parse 无错误 |
| 7 | mycoder tree 命令 | ASC-II 渲染正确 |
| 8 | 并发安全 | 两个Agent同时写树不损坏文件 |
