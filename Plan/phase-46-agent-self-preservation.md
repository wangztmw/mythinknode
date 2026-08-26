# Phase 46 计划：Agent 进程自保机制

> **创建时间**：2026-08-02
> **状态**：✅ 已实施并验证完成（2026-08-02）
> **核心文件**：`src/tools-v2/BashTool/BashTool.ts`、`src/tools-v2/BashTool/prompt.ts`
> **触发事件**：Phase 45 实施中，Agent 执行 `pkill -f "dist/main.js"` 杀死自己及所有同类进程
> **问题类型**：系统性安全缺陷

---

## 一、问题陈述

### 真实事件还原

在 Phase 45（CLI EOF 修复）的验证阶段，MyCoder 的集群回归测试被 SIGTERM 超时杀死后，Agent 自动执行清理操作：

```bash
pkill -f "dist/main.js"    # ← 杀死自己！Agent 本身就是 node dist/main.js
pkill -f "run_cluster_test"
```

Agent 自身进程被终止，修复链中断。用户不得不手动恢复。

### 这不是偶发事件

任何能在自己进程内执行 shell 的 AI Agent，只要具备以下条件，就必然会在某个时刻踩中这个坑：

1. Agent 能执行任意 shell 命令
2. Agent 有"清理环境/清理残留进程"的意图
3. Agent 不知道自己的 PID，无法排除自己

### 问题分层

| 层级 | 问题 | 严重程度 |
|------|------|---------|
| **L1：自我终止** | `pkill`/`killall` 等广播式杀进程命中自己 | 🔴 致命 |
| **L2：环境破坏** | `rm -rf`、`chmod` 等破坏运行环境 | 🔴 致命（已有部分防护） |
| **L3：资源耗尽** | fork bomb、无限循环写盘等拖死自己 | 🟡 严重 |
| **L4：副作用扩散** | 修改系统配置影响其他服务 | 🟡 中等 |

本计划重点解决 **L1（自我终止）**，并加固 L2。

---

## 二、根因分析

### 当前防御体系（BashTool.ts 17-26 行）

```ts
const DANGEROUS_PATTERNS = [
  { pattern: /rm\s+.../,           msg: 'recursive force delete from root' },
  { pattern: /rm\s+.../,           msg: 'recursive force delete from home' },
  { pattern: />\s*\/dev\/sd[a-z]/, msg: 'overwriting raw disk device' },
  { pattern: /mkfs\./,             msg: 'creating filesystem' },
  { pattern: /dd\s+if=.*of=\/dev/, msg: 'writing raw image to disk' },
  { pattern: /:\s*\{\s*:\|:\s*&\s*\};/, msg: 'fork bomb pattern' },
  { pattern: /chmod\s+...777/,     msg: 'world-writable permissions on root' },
];
```

### 五大缺口

| # | 缺口 | 为什么存在 | 后果 |
|---|------|-----------|------|
| 1 | **没有自 PID 记录** | BashTool 启动时未保存 `process.pid` | Agent 无法排除自己 |
| 2 | **`pkill`/`killall` 未拦截** | 危险模式只覆盖了文件系统破坏 | 广播杀进程无任何阻拦 |
| 3 | **模式匹配太窄** | 只拦截"明显恶意"的模式，`pkill -f dist/main.js` 看起来合法 | 合法语法 + 恶意效果 = 漏网 |
| 4 | **Prompt 无安全提示** | `prompt.ts` 只有 5 行功能描述 | 模型没有被提醒进程安全 |
| 5 | **没有确认机制** | 所有命令一条路走到底 | 危险操作无"二次确认" |

### 为什么"加一条 pkill 正则"不够

如果只在 `DANGEROUS_PATTERNS` 里加 `pkill`，Agent 明天会用：
- `killall node`
- `ps aux | grep main.js | awk '{print $2}' | xargs kill`
- `kill $(pgrep -f main.js)`
- `for pid in $(pgrep node); do kill $pid; done`

**正则匹配无法穷举所有杀进程的方式。** 需要从架构层面解决。

---

## 三、修复方案（四层防御）

### 3.1 第一层：自 PID 感知（代码层，最小代价）

在 BashTool 初始化时记录自己的 PID 和进程名，命令执行前检查。

```ts
// 在 BashTool 模块顶层
const SELF_PID = process.pid;
const SELF_EXEC = process.argv0; // "node"
const SELF_SCRIPT = process.argv[1]; // "dist/main.js" 或类似

// 提取当前进程的关键标识词
const SELF_IDENTITY = [
  path.basename(SELF_SCRIPT),          // "main.js"
  path.basename(SELF_SCRIPT, '.js'),   // "main"
  path.basename(path.dirname(SELF_SCRIPT)), // "dist"
].filter(Boolean);
```

### 3.2 第二层：进程管理命令拦截（代码层）

拦截所有"广播式进程操作"——即不需要指定 PID 就能杀死一批进程的命令。

```ts
const PROCESS_MANAGEMENT_PATTERNS = [
  // 广播杀进程（按名称/模式匹配，非按 PID）
  { pattern: /\bpkill\b/,                  msg: 'broadcast kill by name (pkill)' },
  { pattern: /\bkillall\b/,                msg: 'broadcast kill by name (killall)' },
  // 组合拳：ps/grep 管道到 kill
  { pattern: /\bps\b.*\bkill\b/,           msg: 'ps + kill pipeline' },
  { pattern: /\bpgrep\b.*\bkill\b/,        msg: 'pgrep + kill pipeline' },
  { pattern: /\bpgrep\b.*\bxargs\b.*\bkill\b/, msg: 'pgrep + xargs kill pipeline' },
  // 直接 kill 无目标 PID（shell 语法糖）
  { pattern: /\bkill\b\s*%/,               msg: 'kill job by id' },
];
```

**拦截策略**：不直接 BLOCK，而是返回警告并要求 Agent 使用更精确的方式（指定 PID 或使用 Bash 后台任务管理）。

实际上，对于广播式杀进程，应该直接 BLOCK。Agent **永远不应该** 使用 `pkill`、`killall` 或 `ps | xargs kill` 这类命令。如果它需要清理子进程，应该通过 BashTool 自身的后台任务管理（`run_in_background` + taskRegistry）来做。

### 3.3 第三层：自引用检测（代码层）

在执行前检测命令是否包含指向自身进程的引用。

```ts
function targetsSelf(command: string): boolean {
  // 检查命令是否引用了自己可能匹配的模式
  const selfPatterns = SELF_IDENTITY.map(id => 
    new RegExp(`\\b${escapeRegex(id)}\\b`, 'i')
  );
  // 检查命令是否包含 kill/stop/term + 自身标识
  const killVerbs = /\b(kill|pkill|killall|stop|term|SIGTERM|SIGKILL)\b/;
  
  if (!killVerbs.test(command)) return false;
  return selfPatterns.some(p => p.test(command));
}
```

如果命中，返回明确的拒绝信息，包含为什么被拦截、自己的 PID 是什么。

### 3.4 第四层：Prompt 安全指令（提示层）

在 BashTool 的 prompt 中加入安全指令，让模型在产生命令之前就避免危险操作。

```ts
export const DESCRIPTION = `Execute a shell command. This is the primary tool for: running code, tests, git, npm, file ops.

⚠️ PROCESS SAFETY RULES (HARD CONSTRAINTS — violation = blocked):
- NEVER use pkill, killall, or any broadcast process-kill command
- NEVER use "ps | grep ... | xargs kill" or similar pipelines
- To clean up background tasks, use the task management system (TaskTool), NOT shell commands
- If you need to kill a specific process, you MUST know its exact PID — but you usually don't need to
- Your own PID is ${process.pid} — never send signals to yourself

- Commands run in the project working directory.
- Returns stdout and stderr.
- Timeout: 120 seconds.`;
```

---

## 四、设计决策

### 4.1 为什么"直接 BLOCK"而不是"警告+确认"

| 方案 | 优点 | 缺点 |
|------|------|------|
| 直接 BLOCK | 零风险，不给模型犯错机会 | 极端情况下可能需要手动执行 |
| 警告+确认 | 灵活 | 模型可能在确认时仍然犯错 |

**选择直接 BLOCK**。理由：
1. Agent **永远不应该** 用 `pkill`/`killall`——这些是给人类管理员用的工具，不是给自动化 Agent 用的
2. Agent 清理子进程的正确方式是 taskRegistry（Phase 44 已实现），不需要 shell 命令
3. 如果真有极端需要，人类用户可以在终端手动执行

### 4.2 为什么不拦截"指定 PID 的 kill"

`kill <pid>` 指定了明确的 PID，不太可能误杀自己（除非模型算错了 PID，但那概率远低于广播杀进程）。保留这个通道给真正需要的场景（如杀死卡死的子进程）。

但加上保护：如果 PID 恰好等于 `process.pid`，直接拒绝。

### 4.3 与现有 DANGEROUS_PATTERNS 的关系

保留现有模式，新增 `PROCESS_MANAGEMENT_PATTERNS`，两者分别检查，分别报错。

---

## 五、实施步骤

### 步骤 1：添加自 PID 记录

在 `BashTool.ts` 顶部添加：
```ts
import * as path from 'node:path';

const SELF_PID = process.pid;
const SELF_SCRIPT = process.argv[1] || '';
const SELF_IDENTITY = [
  path.basename(SELF_SCRIPT),
  path.basename(SELF_SCRIPT, '.js'),
].filter(Boolean);
```

### 步骤 2：新增进程管理拦截模式

```ts
const PROCESS_MANAGEMENT_BLOCKED = [
  { pattern: /\bpkill\b/, msg: 'broadcast kill by name. Use task management instead.' },
  { pattern: /\bkillall\b/, msg: 'broadcast kill by name. Use task management instead.' },
  { pattern: /\bps\b.*\|.*\bxargs\b.*\bkill\b/, msg: 'ps + xargs kill pipeline. Use task management instead.' },
  { pattern: /\bkill\b\s*-9\b/, msg: 'SIGKILL (-9). Use task management or SIGTERM with exact PID instead.' },
  { pattern: /\bkill\b\s*%.*/, msg: 'kill job by shell job id. Use task management instead.' },
];
```

### 步骤 3：添加自引用检测函数

```ts
function targetsSelf(command: string): boolean {
  const killVerbs = /\b(kill|pkill|killall|stop|SIGTERM|SIGKILL)\b/i;
  if (!killVerbs.test(command)) return false;
  
  const selfPatterns = SELF_IDENTITY.map(id => {
    try { return new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'); }
    catch { return null; }
  }).filter(Boolean) as RegExp[];
  
  return selfPatterns.some(p => p.test(command));
}
```

### 步骤 4：在 call() 中插入检查逻辑

在现有 `DANGEROUS_PATTERNS` 检查之后，新增：
```ts
// 进程管理命令拦截
for (const { pattern, msg } of PROCESS_MANAGEMENT_BLOCKED) {
  if (pattern.test(command)) {
    return { data: `BLOCKED: Unsafe process management — ${msg}.\nYour PID: ${SELF_PID}. Use Bash background tasks (run_in_background) + TaskTool for process lifecycle.` };
  }
}

// 自引用检测
if (targetsSelf(command)) {
  return { data: `BLOCKED: This command appears to target your own process.\nYour PID: ${SELF_PID}. Command: ${command}` };
}
```

### 步骤 5：更新 prompt.ts

加入进程安全规则（见 3.4 节）。

### 步骤 6：更新 DANGEROUS_PATTERNS

增加两个实用模式：
```ts
{ pattern: /\bkill\b\s+-9\s+1\b/, msg: 'SIGKILL on PID 1 (init/systemd)' },
{ pattern: /\breboot\b/, msg: 'system reboot' },
{ pattern: /\bshutdown\b/, msg: 'system shutdown' },
```

### 步骤 7：编译验证

```bash
npx tsc --noEmit
```

### 步骤 8：验证测试

编写验证脚本，覆盖以下场景：

| 测试 | 输入 | 期望 |
|------|------|------|
| pkill 拦截 | `pkill -f "main.js"` | BLOCKED |
| killall 拦截 | `killall node` | BLOCKED |
| ps+xargs kill 拦截 | `ps aux \| grep main \| awk '{print $2}' \| xargs kill` | BLOCKED |
| kill -9 拦截 | `kill -9 12345` | BLOCKED (--9 模式) |
| 正常 kill by PID | `kill 12345` | 通过 |
| 正常命令不受影响 | `ls -la`、`echo hello` | 通过 |
| 自引用检测 | `kill $(pgrep -f main.js)` | BLOCKED (targetsSelf) |
| 原有危险模式 | `rm -rf /` | BLOCKED (原有) |

---

## 六、不做的事（明确边界）

| 不做 | 原因 |
|------|------|
| 沙箱/容器隔离 | 过于重量级，Phase 46 只做代码层防护 |
| SELinux/AppArmor 配置 | 不是 Node 应用层的职责 |
| 拦截所有 kill | `kill <pid>` 指定明确 PID 的场景保留 |
| 进程级权限 dropping | 复杂度太高，收益有限 |
| 拦截 chmod/chown 等 | 现有 DANGEROUS_PATTERNS 已覆盖危险模式 |

---

## 七、风险与边界

| 风险 | 缓解 |
|------|------|
| Agent 绕过正则（如 base64 编码命令） | 正则是最低防线，核心防线是 prompt 层的"不要做"指令 |
| 用户确实需要 pkill（调试场景） | 用户在终端手动执行，不走 Agent |
| 自引用检测的假阳性 | 只检查 kill 类命令 + 自身标识同时出现，假阳性概率极低 |
| Agent 改用其他方式自杀（如 `process.exit()` 写在 JS 里执行） | 不在此 phase 范围内，需 Phase 47 做沙箱 |

---

## 八、实施清单

- [x] 添加 SELF_PID / SELF_IDENTITY 到 BashTool 模块顶层
- [x] 新增 PROCESS_MANAGEMENT_BLOCKED 模式数组
- [x] 实现 targetsSelf() 检测函数
- [x] 在 call() 中插入两层新检查（进程管理拦截 + 自引用检测）
- [x] 更新 prompt.ts 加入进程安全规则
- [x] 补充 DANGEROUS_PATTERNS（reboot/shutdown/kill -9 1）
- [x] 顺手修复预存 bug：fork bomb 正则（`(){` 而非 `{`）、rm -rf / 末尾 `\b`→`(\b|$|\s)`、SELF_IDENTITY 扩名 `.mjs` 兼容
- [x] tsc --noEmit 编译通过
- [x] 跑验证测试脚本（22 个场景全覆盖）

### 验证结果（2026-08-02）

| 类别 | 场景数 | 通过 | 失败 |
|------|--------|------|------|
| 进程管理拦截 | 7 | 7 | 0 |
| 自引用检测 | 1 | 1 | 0 |
| 系统级破坏 | 3 | 3 | 0 |
| 文件系统破坏（原有） | 3 | 3 | 0 |
| 正常命令 | 6 | 6 | 0 |
| 边界场景 | 2 | 2 | 0 |
| **总计** | **22** | **22** | **0** |

### 最终改动的文件

| 文件 | 改动 |
|------|------|
| `src/tools-v2/BashTool/BashTool.ts` | +40 行：SELF_PID、targetsSelf()、PROCESS_MANAGEMENT_BLOCKED、call() 内两层新检查、DANGEROUS_PATTERNS 扩展+修复 |
| `src/tools-v2/BashTool/prompt.ts` | +5 行：进程安全规则
