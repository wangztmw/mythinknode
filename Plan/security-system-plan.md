# 安全检测系统 — 四层架构规划

> **创建时间**：2026-08-01
> **核心关键词**：安全检测、AST解析、权限系统、沙箱、Hooks
> **状态**：远期规划（当前 7 个正则够用）

---

## 一、当前状态

my-coder 的安全只依赖 BashTool 里的 7 个危险命令正则：

```
rm -rf /, rm -rf ~, >/dev/sd*, mkfs.*, dd if=...of=/dev/, fork bomb, chmod 777 /
```

**够用，但上限很低。** 正则只能拦截字符串匹配的已知模式，无法识别命令替换 `$(whoami)`、无法区分 `VAR=val git push` 中的环境变量赋值、无法感知"这个命令可以安全放行还是应该询问"。

Claude Code 的安全系统是四层叠加的——从底层语法理解到顶层人类规则。以下按这个架构规划 my-coder 的安全升级路径。

---

## 二、四层架构

### 第一层：语法层 — 知道命令在做什么

**目标**：用 tree-sitter 把 Bash 命令解析成 AST，精确识别子命令拆分、环境变量赋值、命令替换、花括号展开。

**参考源码**：`utils/bash/`（23 文件，12,306 行）

```
输入: "VAR=val git push && $(echo npm) test"
AST:  ├── 环境变量赋值: VAR=val
      ├── 子命令1: git push
      ├── 操作符: &&
      └── 子命令2: $(echo npm) test → too-complex (命令替换)
```

**核心设计原则（直接复用）**：FAIL-CLOSED。AST 理解不了的节点，不假设安全，标记为需要用户确认。

**实现要点**：
- 安装 `tree-sitter` + `tree-sitter-bash` 两个 npm 包
- 用 tree-sitter 的 WASM binding（不需要原生编译）
- 只允许白名单 node type——不在白名单里的，标记 `too-complex`
- 解析失败 → fail-closed → 弹确认

**代码量估计**：~500 行（原始 7,621 行里大部分是边界情况处理，可以先做核心路径）

**优先级**：⭐⭐ — 当前正则够用，但有 AST 后权限系统才能精确到子命令级别

---

### 第二层：规则层 — 决定允不允许

**目标**：对每个子命令做规则匹配——allow/deny/ask，支持通配符，支持文件路径边界检查。

**参考源码**：`utils/permissions/`（24 文件，9,409 行）

```
规则示例:
  Bash(git *)     → allow    (所有 git 命令自动放行)
  Bash(rm -rf *)  → deny     (递归删除拦截)
  Bash(curl *)    → ask      (网络请求需确认)
  Write(./src/**) → allow    (项目内写文件放行)
  Write(/etc/*)   → deny     (系统目录写拦截)
```

**层级**：
```
1. 精确匹配: Bash(git push) → allow
2. 通配符:   Bash(git *)     → allow  
3. 分类器:   用 Haiku 模型预判（可选，太重）
4. 默认策略: ask（不知道的就问）
```

**deny 优先于 allow**——即使有 `Bash(*)` → allow 的通配规则，`Bash(rm -rf /)` → deny 优先命中。

**实现要点**：
- 规则文件：`.mycoder/safety.json`（JSON 格式，不需要 4 层配置继承）
- 每条规则: `{ "pattern": "Bash(git *)", "action": "allow" }`
- 路径边界检查：Write/Edit 的目标必须在项目目录内（resolve + relative 验证）
- 不需要 14 步管线——单用户不需要分类器、不需要权限模式切换

**代码量估计**：~300 行

**优先级**：⭐⭐⭐ — 安全系统最有价值的层，即使是单用户也能防止误操作

---

### 第三层：隔离层 — 做了也被关着

**目标**：用 Bubblewrap（Linux）/ Seatbelt（macOS）把 Bash 命令包在沙箱里，限制文件读写和网络访问。

**参考源码**：`utils/sandbox/`（997 行）

```
沙箱内:  能读 /home/user/project/ → 正常
         能写 /home/user/project/output/ → 正常
         读 /etc/passwd → 被拦截
         写 /usr/bin/ → 被拦截
         连 external-api.com → 被拦截（可选）
```

**macOS Seatbelt**：系统内置的强制访问控制（MAC），通过 `sandbox-exec` 加载 .sb 配置文件，定义文件/网络/进程权限。不需要装任何东西。

**Linux Bubblewrap**：非特权用户命名空间，通过 `bwrap` 命令创建隔离环境。挂载空白 tmpfs、按需 ro-bind 目录。

**实现要点**：
- 检测当前 OS → 选择 Seatbelt 或 Bubblewrap
- 生成沙箱配置文件（允许的目录、禁止的目录、网络权限）
- 在 `BashTool.call()` 执行前包一层 `bwrap` 或 `sandbox-exec`
- 非沙箱命令（Read/Write/Edit）不需要
- 可配置开关：`MYCODER_SANDBOX=1` 启用

**代码量估计**：~200 行（生成配置文件 + 包装命令）

**优先级**：⭐ — 单用户场景必要性最低。除非要开放给别人用，否则不需要

---

### 第四层：行为层 — 人类定规则

**目标**：允许用户在工具调用前后执行自定义脚本——"每次 git push 前跑测试"、"每次编辑完跑 linter"。

**参考源码**：`utils/hooks/`（17 文件，3,721 行）

```
Hook 类型:
  PreToolUse:   工具调用前执行
  PostToolUse:  工具调用后执行
  Notification: 特定事件时通知
  SessionStart: 会话启动时初始化

Hook 配置示例 (.mycoder/hooks.json):
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash(git push*)", "command": "npm test" }
    ],
    "PostToolUse": [
      { "matcher": "Edit(*)", "command": "npx eslint ${MYCODER_FILE}" }
    ]
  }
}
```

**实现要点**：
- Hook 配置文件：`.mycoder/hooks.json`
- Hook 进程：`child_process.spawn` 执行 shell 命令
- 环境变量注入：`MYCODER_TOOL`（工具名）、`MYCODER_FILE`（操作文件）、`MYCODER_INPUT`（工具输入 JSON）
- 超时：每个 hook 最长 30 秒
- 非零退出码 → 拦截工具调用

**代码量估计**：~200 行

**优先级**：⭐⭐ — 对个人工作流有价值，但不是安全必需品

---

## 三、实施路线图

### Phase S1：规则层（建议优先）
- 创建 `.mycoder/safety.json` 规则文件
- 实现规则匹配引擎（精确 + 通配符）
- 在 `runAgent` 工具调用前接入 checkPermissions
- deny 优先于 allow，默认 ask
- 路径边界检查（Write/Edit 不超出项目目录）

### Phase S2：语法层
- 安装 tree-sitter + tree-sitter-bash
- 实现 FAIL-CLOSED AST 解析
- 替换当前的危险命令正则
- 接入权限规则匹配（按子命令粒度）

### Phase S3：行为层
- 实现 Hook 系统
- 支持 PreToolUse / PostToolUse / Notification
- 环境变量注入

### Phase S4：隔离层
- macOS Seatbelt 配置文件生成
- Linux Bubblewrap 包装
- 可选开关

---

## 四、当前 vs 目标

| 维度 | 当前（Phase 18-20） | Phase S1（规则层） | Phase S2-4（完整） |
|---|---|---|---|
| 命令解析 | 原始字符串 | 原始字符串 | AST 语法树 |
| 危险检测 | 7 个正则 | 7 个正则 + 规则引擎 | AST 节点白名单 |
| 权限控制 | 无（全部 allow） | allow/deny/ask 规则 | 14 步管线 |
| 沙箱 | 无 | 无 | Bubblewrap/Seatbelt |
| Hooks | 无 | 无 | Pre/PostToolUse |
| 代码量 | ~20 行 | +~300 行 | +~1,200 行 |

---

## 五、设计原则

1. **层层独立**：每一层可以单独开启/关闭，不依赖其他层
2. **FAIL-CLOSED**：解析失败假设不安全，不是假设安全
3. **deny > allow**：显式拒绝规则不可被通配规则覆盖
4. **配置驱动**：规则/Hooks 用 JSON 文件配置，不硬编码
5. **个人优先**：先做对自己最有价值的（规则层），后做给别人用的（沙箱）
