# 执行安全层独立化计划（Detach Exec Security Layer）

> **创建时间**：2026-08-02
> **状态**：规划中（待评审）
> **核心目标**：把当前散落在 `BashTool` 里的"执行安全层"沉淀成可复用的独立模块，评估能否单独成为一个库/包/独立工具
> **关联**：深关联 `Plan/security-system-plan.md`（远期四层愿景），本文聚焦"当前已实现的执行安全层"现状与拆分

---

## 一、现状总结：执行安全层目前在哪、包含什么

当前的"安全层"**全部内嵌在 `src/tools-v2/BashTool/BashTool.ts` 的 `call()` 函数开头**，是一条**线性前置检查管道**，约 60 行，被硬编码在 Bash 工具里。它不是独立模块，无法单独复用。

### 1.1 三层防御的实际代码分布

| 防御层 | 触发逻辑 | 代码行 | 防护对象 |
|--------|---------|--------|---------|
| **广播式进程管理拦截** | `PROCESS_MANAGEMENT_BLOCKED` 数组 + 正则（pkill/killall/ps+xargs kill/kill -9） | L57-63, 73-77 | 阻止 Agent 用 shell 广播杀进程，强制走 TaskTool |
| **自 PID 感知（防自杀）** | `SELF_PID`/`SELF_SCRIPT` + `targetsSelf()`，识别 kill/pkill 中命中自身进程名 | L23-39, 80-82 | 防止 Agent 误杀自己所在进程 |
| **危险命令拦截** | `DANGEROUS_PATTERNS` 数组 + 正则（rm -rf /、rm -rf ~、mkfs、dd to /dev/、fork bomb、reboot、shutdown、kill -9 1 等） | L42-54, 85-89 | 文件系统/系统级破坏 |

### 1.2 执行安全层的特点

- **只覆盖 BashTool 一个工具**——Read/Write/Edit/Glob/Grep 等文件操作工具**没有任何安全校验**（允许任意路径读写）
- **纯字符串正则匹配**——无法理解命令替换 `$(...)`、环境变量赋值、复合命令 `&&`/`;` 的边界
- **拦截模式是"静默返回提示"**——命中后返回 `data` 字符串而非抛错，Agent 会读到"BLOCKED: ..."
- **单层"执行前"检查**——没有执行后审计，没有权限规则，没有沙箱
- **代码与 BashTool 强耦合**——`SELF_PID`、错误提示字符串都写死在 BashTool 内部

### 1.3 已有规划的关系

`Plan/security-system-plan.md` 规划了四层愿景：**语法层(AST) → 规则层(allow/deny/ask) → 隔离层(沙箱) → 行为层(Hooks)**。那是"未来完整版"。

**本文要解决的问题不同**：不是再规划新功能，而是——
1. 把**当前已经在跑、已验证有效**的这三层拦截整理成规范接口
2. 评估能否**从 BashTool 里剥离**，变成独立可复用的东西（模块 / npm 包 / 独立 CLI 工具）
3. 为后续叠加"规则层/语法层/沙箱层"留好扩展点

---

## 二、为什么要独立化

1. **复用性**：现在安全逻辑锁死在 BashTool。未来若有其他工具（沙箱 Bash）、其他 Agent 系统需要同一套拦截，无法复用。
2. **可测试性**：内嵌在 tool 里无法单测。独立成纯函数后可做单元测试（输入命令 → 断言拦截结果）。
3. **可扩展性**：独立出统一的 `SecurityRule[]` 接口后，后续叠加规则层、AST 层只需追加规则/替换引擎，不动 BashTool。
4. **独立价值**：这个"shell 命令安全拦截器"本身就是一个有价值的小工具——可单独作为 npm 包（如 `exec-safe`)被任何需要执行命令行工具的 Node 应用引用。**这是一个潜在的独立产品方向。**

---

## 三、目标拆分架构

```
src/
├── security/                  ← 新增独立目录（从 BashTool 剥离）
│   ├── types.ts              ~40 行   SecurityRule/Verdict 类型定义
│   ├── rules.ts              ~90 行   三层内置规则（从 BashTool 迁移）
│   ├── check.ts              ~50 行   规则引擎：遍历规则 → 返回判定
│   └── index.ts              ~20 行   对外入口 checkCommandSafety(cmd)
└── tools-v2/BashTool/BashTool.ts   ← 改为主委托 security/
```

### 3.1 核心接口设计

```ts
// types.ts
export type SecurityVerdict =
  | { ok: true }                                    // 放行
  | { ok: false; category: string; message: string } // 拦截

export interface SecurityRule {
  /** 规则唯一标识 */
  id: string;
  /** 规则类别：process / self / destructive */
  category: 'process' | 'self' | 'destructive';
  /** 匹配函数，返回 null 表示不命中 */
  match(command: string, ctx?: SecurityContext): Omit<SecurityVerdict, 'ok'> | null;
}

export interface SecurityContext {
  selfPid: number;
  selfNames: string[];   // 自身进程可能命中的名称标识
}
```

```ts
// check.ts — 引擎
export function checkCommandSafety(command: string, rules: SecurityRule[], ctx: SecurityContext): SecurityVerdict {
  for (const rule of rules) {
    const hit = rule.match(command, ctx);
    if (hit) return { ok: false, ...hit };
  }
  return { ok: true };
}
```

**设计要点**：
- **返回判定对象而非直接组装提示**——拦截提示字符串由 BashTool 负责拼（提示里含自定义的"用 TaskTool"引导文案），规则层只管"命中了哪类"。这样规则可复用而提示可定制。
- **规则可注入**——BashTool 用内置规则 + 可选的外部自定义规则（为未来规则层铺路）。
- **纯函数、无副作用**——便于单测和打包。

### 3.2 BashTool 接入方式（改动最小）

```ts
// BashTool.ts 中替换掉内嵌的三段 for 循环
import { defaultRules, checkCommandSafety } from '../security/index.js';

const verdict = checkCommandSafety(command, defaultRules, {
  selfPid: process.pid,
  selfNames: SELF_IDENTITY,
});
if (!verdict.ok) {
  const guidance = verdict.category === 'process'
    ? 'Use TaskTool to manage sub-agents, or run_in_background for background bash.'
    : 'Command blocked for safety.';
  return { data: `BLOCKED: ${verdict.message}\nCommand: ${command}\n\n${guidance}` };
}
```

---

## 四、独立化程度的三档选项（评估）

按拆出来的东西能走多远分三档，从轻到重：

### 选项 A：项目内独立模块（推荐，低风险）
- 把三层逻辑搬到 `src/security/`，BashTool 委托调用
- **价值**：可复用、可单测、为未来扩展留位
- **工作量**：~3 小时重构 + ~1 小时测试
- **对外**：不发布，仅项目内

### 选项 B：独立 npm 包（中投入）
- 把 `src/security/` 抽成独立包，如 `@mycoder/exec-safe`
- 暴露 `checkCommandSafety(cmd) => verdict`，纯函数零依赖
- 附带规则集：进程管理 / 自杀 / 破坏性命令
- **价值**：任何执行 shell 的 Node 应用都能用；可作为独立产品的小底座
- **额外工作**：包配置、README、单元测试、示例；需处理 `zod`？——**不需要**，安全层无 zod 依赖（规则层未来做 schema 时才需要）
- **风险**：当前正则分类不完善，API 一旦发布就锁定了

### 选项 C：独立 CLI 工具（最高投入）
- 命令行 `safe-exec "cmd"`，内部调用检查器，通过则执行
- 可作为系统层工具，配合其他 Agent 使用
- **价值**：真正的"独立工具"，不绑定 my-coder
- **额外工作**：CLI 入口、退出码约定、参数解析、安装脚本
- **风险**：与选项 B 边界重叠；当前正则深度不足，早期发布易被绕过的负面口碑

### 三档对比

| 维度 | A 模块 | B npm 包 | C CLI 工具 |
|------|--------|----------|-----------|
| 工作量 | ~4h | ~8h | ~12h |
| 复用范围 | 本项目 | 任意 Node 应用 | 任意 shell 环境 |
| 独立产品价值 | 低 | 中 | 高 |
| 前置要求 | 无 | 需补测试+文档 | 需先做 B |
| 推荐 | ⭐⭐⭐ 先做 | ⭐⭐ 下一步 | ⭐ 最终形态 |

**推荐路径**：先做 A（立即可做），评估足够后再做 B，B 稳定后再考虑 C。

---

## 五、现有规则覆盖盲区（独立化时需修正）

当前正则**漏掉的场景**，拆分时应补上或明确记录为"留给规则层"：

| 盲区 | 现状 | 处理建议 |
|------|------|---------|
| `$(whoami)` / 命令替换 | 完全无法识别 | 记入文档，交语法层 |
| 环境变量赋值 `VAR=val git push` | 不识别 | 记入文档，交语法层 |
| 复合命令 `git push && rm -rf /tmp/x` | 正则只匹配整串 | 拆分为逐段规则；`rm -rf /tmp` 合法但需注意 `~`/`/` 边界 |
| 其他文件工具的安全 | Read/Write/Edit 无任何校验 | **独立化安全层时应声明扩展到 File/Edit/Write**（路径边界检查）——这是当前最真实的缺口 |
| 符号链接逃逸 | 不处理 | 文件工具路径边界检查时处理 |

---

## 六、分步实施计划（先做选项 A）

### Step 1：抽取类型与接口
- 新建 `src/security/types.ts`，定义 `SecurityVerdict` / `SecurityRule` / `SecurityContext`

### Step 2：迁移三层内置规则
- 用编辑将 BashTool 的 `PROCESS_MANAGEMENT_BLOCKED`、`targetsSelf`、`DANGEROUS_PATTERNS` 完整搬到 `src/security/rules.ts`
- 保持正则不变（**行为零变化**原则），只改结构

### Step 3：实现检查引擎
- `src/security/check.ts` 的 `checkCommandSafety()` 纯函数

### Step 4：改写 BashTool 接入
- BashTool 删除内嵌循环，改为 `checkCommandSafety + 提示拼装`
- ⚠️ 保留 `SELF_PID`/`SELF_IDENTITY` 计算在 BashTool（它依赖 `process.argv`），通过 `selfNames` 传入

### Step 5：验证零行为变化
- `npx tsc --noEmit` 零错误
- 手动跑几个典型命令，比对拦截结果与拆分前**完全一致**：
  - `pkill node` → 拦截（process）
  - `kill -9 1` → 拦截（process）
  - `rm -rf /` → 拦截（destructive）
  - `echo hi` → 放行
  - `git status` → 放行

### Step 6：补充单元测试（为选项 B 铺路）
- 加 `tests/`，用 node 内置 test runner 或 vitest
- 覆盖以上 5 个典型样例 + 边界

### Step 7：记录与评审
- 更新 `Plan/security-system-plan.md` 引用本文
- 评估是否推进选项 B

---

## 七、与风险

| 风险 | 缓解 |
|------|------|
| 拆分导致行为变化 | 正则原样迁移 + Step5 逐条比对 |
| 自 PID 计算依赖 `process.argv` | 在 BashTool 保留计算，通过 ctx 传入，安全层保持纯函数 |
| 盲区暴露 | 明确记录，不承诺覆盖，交规则层 |
| 提示文案变化 | 提示拼装留在 BashTool，规则层只给 category |

---

## 八、结论

**当前"执行安全层" = BashTool 内嵌的 3 层线性正则拦截，可用但不可复用、不可测试、无法扩展。**

建议**先拆为项目内独立模块 `src/security/`（选项 A）**，保持行为零变化；这套拦截逻辑有独立成 npm 包（`exec-safe`）的潜质，作为可复用的 shell 命令安全守卫，后续叠加规则层/AST 层后价值将进一步放大。

**独立产品可行性初判**：✅ 有——但需要先把正则盲区（命令替换/复合命令/文件路径）补上，才能作为对外发布的产品级守卫。当前先做模块化，产品化留到规则层(AST)落地后更有底气。
