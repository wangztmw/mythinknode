# Task、Agent、Swarm — 三层关系与实现分析

> **创建时间**：2026-08-02
> **核心关键词**：Task、AgentTool、Swarm、子Agent、多Agent协作、后台任务
> **参考源码**：tasks/(12文件, 3,286行) + tools/AgentTool/(20文件, 6,782行) + utils/swarm/(22文件, 7,548行)

---

## 一、三者关系：不是一回事，但 Task 是底座

```
Swarm (多进程集群)
  └── 每个进程内:
        AgentTool (子Agent创建)
          └── Task 系统 (后台进程管理)
                ├── LocalShellTask  (后台Bash命令)
                ├── LocalAgentTask  (子Agent执行)
                ├── DreamTask       (空闲自学)
                └── InProcessTeammateTask (同进程Agent)
```

**Task** = 进程管理。像操作系统的进程表——启动、监控、杀死、输出捕获。不关心"这个进程在做什么"，只关心"它还在跑吗、输出了什么、要不要杀掉"。

**AgentTool** = 子Agent工具。当主 Agent 调 `AgentTool.call()` 时，它创建一个新的 Agent 上下文（独立的 messages 数组、限制的工具集、专门的 system prompt），任务完成后返回结果给主 Agent。

**Swarm** = 分布式集群。多个独立的 Claude Code 进程跑在不同的 tmux 窗格或后台终端里，通过消息队列互相通信。有 Leader/Worker 角色分配。

---

## 二、Task 系统 — 异步工作的"进程表"

### 五种任务类型

```
local_bash        后台 Shell 命令（> timeout 的命令自动切后台）
local_agent       子 Agent 执行（AgentTool 创建的）
remote_agent      远程 Agent（通过 bridge 在 IDE 里跑）
in_process_teammate  swarm 内的同进程 Agent
dream             空闲时自主学习
monitor_mcp       监控 MCP 连接状态
```

### 生命周期

```
创建:   TaskHandle = { taskId, cleanup }
状态:   pending → running → completed/failed/killed
输出:   写入磁盘文件 (taskOutputPath), Agent 通过 TaskOutputTool 读取
通知:   completed/failed 时通知主 Agent（注入一条 system message）
清理:   cleanup() 杀掉子进程 + 删除临时文件
```

### 关键：不是工具，是底层基础设施

Task 本身没有 Tool 接口。它是被 AgentTool、BashTool（run_in_background）、DreamTask 调用的底层机制。用户看不到 Task——用户看到的是"这个命令在后台运行"、"子Agent在跑"、"子Agent完成了"。

---

## 三、AgentTool — 子 Agent 的"fork + exec"

### 完整流程

```
主Agent 调用 AgentTool:
  input: { description: "修这个bug", prompt: "去看 foo.ts 第42行...", subagent_type: "general-purpose" }

AgentTool.call():
  1. forkSubagent() — 创建子Agent上下文
     - 新的 messages = [{ role: "user", content: taskPrompt }]
     - 新的 system prompt (DEFAULT_AGENT_PROMPT)
     - 限制的工具集（不传危险工具给子Agent）
     - 独立的 abortController
     - 共享主Agent的文件读写权限

  2. runAgent() — 启动 Agent 循环
     - 和主Agent一样的 while(model→tool→model) 循环
     - 子Agent可以调工具
     - 结果通过 agentMemory 暂存

  3. 返回结果给主Agent
     - 方式一(同步): 等子Agent跑完, return { data: result }
     - 方式二(后台): 先 return taskId, 子Agent在后台跑, 
       完成后注入 system message 通知主Agent

  4. agentSummary() — 结果压缩
     - 子Agent的完整对话可能很长(读了几十个文件)
     - 只把关键结论提取出来, 塞回主Agent的上下文
     - 不把子Agent的整个 messages 数组合并到主Agent
```

### 关键设计

**上下文隔离**：子Agent 不继承主Agent 的 messages 历史。只传一条 user message（任务描述 + 必要的文件内容）。这是解决"角色混淆"问题的方案一。

**工具限制**：子Agent 默认不能调 AgentTool（防止无限递归 spawn），不能调危险工具，可以限制 allowedTools 白名单。

**内存隔离**：子Agent 的 tool_use 和 tool_result 不进入主Agent 的 messages。只通过 `agentSummary()` 返回摘要。

---

## 四、Swarm — 多进程 Agent 集群

### 和 AgentTool 的本质区别

| | AgentTool | Swarm |
|---|---|---|
| 进程 | 同一进程内 fork | 多个独立进程 |
| 通信 | 内存传递 | 消息队列/mailbox |
| 显示 | 隐藏的 | 每个在独立 tmux 窗格 |
| 启动 | AgentTool.call() | 用户手动 /swarm 命令 |
| 用途 | 委派子任务 | 真正的并行多Agent协作 |

### 架构

```
Leader (主 tmux 窗格 / 终端)
  ├── Worker A (tmux pane 1)
  │     └── 独立的 Claude Code 进程
  │     └── 有自己的 messages, tools, system prompt
  │
  ├── Worker B (tmux pane 2)  
  │     └── 独立的 Claude Code 进程
  │
  └── Leader 通过 mailbox 给 Worker 发任务
       Worker 完成后通过 mailbox 通知 Leader
```

### 关键文件

- `teammateInit.ts` — 初始化 Worker 的 hooks 和权限
- `leaderPermissionBridge.ts` — Leader 的权限决策转发给 Worker
- `mailbox` — 进程间消息队列
- `backends/` — 三种后端: ITerm(tmux)、InProcess、PaneBackend

---

## 五、我们怎么学

### 当前不需要 Swarm

Swarm 需要 tmux/iTerm 集成、多进程管理——太重了。单用户 Agent 不需要。

### AgentTool 最值得学

核心理念——**"fork + 上下文隔离 + 结果压缩"**——是我们实现子 Agent 最直接的参考：

```
// 简化版子Agent（~150行能实现核心）
async function spawnSubAgent(taskDescription: string, context: string): Promise<string> {
  // 1. 创建独立的 messages
  const messages = [
    { role: "system", content: "你是一个子Agent,完成任务后返回结果。" },
    { role: "user", content: `任务: ${taskDescription}\n上下文: ${context}` }
  ];

  // 2. 独立的 Agent 循环（最多10轮）
  for (let i = 0; i < 10; i++) {
    const response = await callLLM(SYSTEM_PROMPT, messages);
    if (response.stop_reason === 'end_turn') {
      return extractSummary(response);  // 返回文本摘要
    }
    // ...工具调用循环（和主Agent一样）
  }

  // 3. 结果不进主Agent的messages——只返回摘要字符串
  // 主Agent收到: "[子Agent报告]: 修改了foo.ts第42行,测试通过"
}
```

### Task 系统 — 暂时不需要

后台命令管理、Dream 任务、进程监控——对我们的单用户 CLI Agent 来说过度设计了。需要时再参考 `tasks/types.ts`（约 200 行）和 `tasks/LocalAgentTask.tsx`（约 682 行）。

---

## 六、实施路线

### Phase M1：简单子Agent（建议先做）
- 在 main.ts 加 `spawnSubAgent(task, context)` 函数
- 独立的 messages + 受限工具集
- 同步返回：等子Agent跑完再继续
- ~150 行

### Phase M2：后台子Agent
- 子Agent 在后台跑，主Agent 继续响应用户
- 完成后通过 system message 通知
- 参考 Task 系统的状态管理
- ~200 行

### Phase M3：多子Agent 并行
- 同时 spawn 多个子Agent，并发执行
- 结果合并
- ~100 行

---

## 七、关键洞察

**AgentTool 的 forkSubagent.ts + agentSummary.ts 是精华**——两个文件，不到 2,000 行，实现了完整的子Agent 创建、执行、结果压缩。不需要 Swarm 的 7,548 行集群管理。

**上下文隔离是核心设计**——不传 messages 历史，只传任务描述。解决角色混淆的同时保持子Agent 的独立性。

**结果压缩比结果传递更重要**——子Agent 可能读了几十个文件、跑了十几个命令，把全部内容塞回主Agent 会爆上下文。只提取关键结论。
