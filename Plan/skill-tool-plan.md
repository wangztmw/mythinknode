# SkillTool 完善计划：从占位符到真正的 Skill 系统

> **创建时间**：2026-08-02
> **状态**：待实施（当前为占位符）
> **相关文档**：`RECONSTRUCTION_PLAN.md` Phase 7、`MASTER_PLAN.md` Phase 9c
> **参考源码**：`Plan/Backup/src-skills/`（`loadSkillsDir.ts`、`bundledSkills.ts`、`mcpSkillBuilders.ts`）

---

## 一、现状问题

### 1. 当前实现是纯占位符

`src/tools-v2/SkillTool/SkillTool.ts` 的 `call()` 只返回一句话，**没有扫描任何目录、没有加载任何 skill**：

```ts
async call({ skill, args }, _ctx) {
  return { data: `Skill "${skill}" invoked${args ? ` with: ${args}` : ''}` };
}
```

inputSchema 只有 `{ skill: string, args?: string }`。

### 2. 描述与实际能力脱节

`prompt.ts` 的 DESCRIPTION 宣称：
> "Skills are packaged workflows defined in `.claude/skills/`"

但代码根本没去读 `.claude/skills/`，造成了「嘴上会、实际不会」的占位状态。

### 3. 无法被 Agent 真正使用

由于调用不返回任何真实的内容，Agent 无法把 skill 的指令文本作为 prompt 扩展来执行，功能名存实亡。

---

## 二、正版 Claude Code Skill 的工作原理

### 1. 扫描的来源（多级目录发现）

`getSkillDirCommands()`（原版 `loadSkillsDir.ts`）会汇总以下位置的 skills：

| 来源 | 路径 | 优先级/说明 |
|------|------|------------|
| **用户级** | `~/.claude/skills/` | `getClaudeConfigHomeDir()/skills` |
| **项目级** | `<cwd>/.claude/skills/` | 向上逐级父目录遍历（`getProjectDirsUpToHome`） |
| **托管/策略级** | `$managed/.claude/skills/` | 策略下发的受管路径 |
| **额外目录** | `--add-dir` 指定的 | `getAdditionalDirectoriesForClaudeMd()` |
| **Bundled（内置）** | `registerBundledSkill()` | 随 CLI 二进制编译分发，见 `bundledSkills.ts` |
| **MCP skills** | 远程注册 | 见 `mcpSkillBuilders.ts`，**远程不可信，禁止内联执行 shell** |
| **Legacy** | `.claude/commands/` | 旧的命令目录，支持单 .md 文件 |

### 2. 目录格式约定（关键）

`loadSkillsFromSkillsDir()` 里写明：
> **Single .md files are NOT supported in /skills/ directory**

每个 skill 必须是一个**目录**，主文件叫 `SKILL.md`：
```
skill-name/
  SKILL.md              ← 主文件，带 YAML frontmatter
  references/           ← 辅助材料，模型按需 Read
```

（只有 `--bare` 模式下才跳过自动发现，只加载显式 `--add-dir`。）

### 3. `SKILL.md` 的 frontmatter 字段

`parseSkillFrontmatterFields()` 会解析以下字段（`~/.claude/skills/codebase-to-course/SKILL.md` 就是真实例子）：

| 字段 | 作用 |
|------|------|
| `description` | 模型可见的简介（省 token，只在调用时才读全文） |
| `when_to_use` | 何时使用，帮助模型决定是否调用 |
| `allowed-tools` | 该 skill 允许调用的工具白名单 |
| `paths` | 条件激活的路径匹配（见下文「条件技能」） |
| `model` | 强制执行某个模型；`inherit` 表示继承 |
| `user-invocable` | 是否可在 `/skill` 手动调用 |
| `args` / `argument-hint` | 参数定义与提示 |
| `hooks` | 前后钩子脚本 |
| `context` | `fork` 时在独立上下文执行 |
| `shell` | 内联 shell 执行方式 |
| `effort` | 努力程度级别 |

### 4. 惰性加载（省 token 的关键）

- 平时只暴露 frontmatter 的 `name` + `description`（`estimateSkillFrontmatterTokens` 只估算 frontmatter 的 token）。
- **完整 `SKILL.md` 正文只在被调用时才读入**，通过 `getPromptForCommand()`：
  - 顶部注入 `Base directory for this skill: <dir>`，让模型可 Read/Grep references；
  - 参数替换：`substituteArguments`；
  - 变量替换：`${CLAUDE_SKILL_DIR}` → skill 自身目录；`${CLAUDE_SESSION_ID}` → 会话 ID；
  - 内联 shell 执行（`!` 开头命令 / ` ```!` 块），带有权限控制。**MCP 远程 skill 一律禁止内联 shell**。

### 5. 条件技能（path 过滤）——「扫描某几个文件夹」的那部分

- `paths:` frontmatter + `activateConditionalSkillsForPaths()`：当模型 touch 到**匹配的文件**时才动态激活对应 skill。
- 用 `ignore` 库做 gitignore 式匹配，路径相对 cwd。
- **不是全局扫描**，而是随文件操作（Read/Write/Edit）**按需激活**。

### 6. 运行时动态发现

`discoverSkillDirsForPaths()`：
- 从被操作文件的父目录**向上逐层**找 `.claude/skills/`（到 cwd 为止，不含 cwd 自身）；
- 跳过 gitignored 目录（防止 `node_modules/xxx/.claude/skills` 静默加载）；
- 按目录深度排序（**离文件更近的 skill 优先级更高**）。

### 7. 去重逻辑

- 用 `realpath` 解析 symlink 得到规范路径，防止同一 skill 经不同路径重复加载；
- 按 `managed > user > project > additional > legacy` 顺序首见优先。

### 8. Bundled skills 机制（`bundledSkills.ts`）

- 随 CLI 编译内置，通过 `registerBundledSkill()` 注册；
- 支持 `files` 字段：首次调用时把引用文件**惰性落盘**到进程内 nonce 目录（`getBundledSkillsRoot()`），安全写入用 `O_NOFOLLOW|O_EXCL` + `0o700`，防止预建的 symlink 攻击；
- 供模型用 Read/Grep 按需读取。

---

## 三、本项目的目标设计

### 目标
把 `SkillTool` 从占位符升级为可用的最小 Skill 系统，**遵循本项目的瘦身哲学**：砍掉原版的安全/策略/遥测等过重部分，但保留「目录发现 + SKILL.md 加载 + 惰性注入 + 参数替换 + 条件激活」的核心能力。

### 最小可用范围（MVP）
1. 扫描用户级 `~/.claude/skills/` 和项目级 `<cwd>/.claude/skills/`（向上二级即可，不必全 home）；
2. 解析 `skill-name/SKILL.md` 的 frontmatter（`name`、`description`、`when_to_use`、`args`）；
3. 调用时把 `SKILL.md` 正文拼进 `data` 返回，做 `${CLAUDE_SKILL_DIR}` 变量替换；
4. 暴露可用 skill 列表给模型（`call('list')` 或 schema 枚举）。

### 明确不做（沿用 `tools-v2-improvements.md` 的取舍）
- ❌ 权限管线（14 步）——单用户不需要；
- ❌ hooks 执行；
- ❌ bundled skills 落盘与 nonce 目录——按需再加；
- ❌ 条件激活（paths）——首批可不做，留作后续增强；
- ❌ MCP skills（远程不可信，复杂度高）——首批不做。

---

## 四、实施步骤

### Step 1：新建 skill 加载模块
**新文件**：`src/tools-v2/SkillTool/skillLoader.ts`
```
- 扫描用户级 + 项目级（当前 cwd + 一级父目录）下的 .claude/skills/
- 只认 skill-name/SKILL.md 格式
- 简单 frontmatter 解析（手写 split，或沿用 zod 已有依赖）
```
**验收**：能列出 `~/.claude/skills/codebase-to-course` 这样的 skill。

### Step 2：扩展 SkillTool 的 schema 与 call
修改 `SkillTool.ts`：
- schema 增加可选 `list` 能力（通过 `skill='list'` 触发）；
- `call()` 调用 `skillLoader`：
  - 找不到 skill → 返回错误 + 可用列表；
  - 找到 → 读 `SKILL.md`，做 `${CLAUDE_SKILL_DIR}` 替换，正文注入 `data` 返回。

### Step 3：更新 prompt.ts
- DESCRIPTION 如实描述当前能力；
- 提示模型：可用 skill 作为可注入的指令文本扩展来执行。

### Step 4：接入工具注册
确认 `src/tools-v2/index.ts` 的 `getAllTools()` 已包含 `SkillTool`（保持与其他工具一致的 `buildTool` 模式）。

### Step 5：编译 + 验证
- `npx tsc` 零错误；
- 手动测试：调用一个已存在的 skill，确认返回其正文。

### Step 6（后续增强，暂缓）
- [ ] 条件激活（`paths` + 文件操作触发）；
- [ ] 运行时动态发现（向上遍历）；
- [ ] 惰性 token 估算 + 只在调用时读全文；
- [ ] bundled skills（register + lazily 落盘）；
- [ ] 去重（realpath）。

---

## 五、验证标准

| 项 | 标准 |
|----|------|
| 编译 | `npx tsc` 零错误 |
| 扫描 | 能发现 `~/.claude/skills/` 和项目 `.claude/skills/` 下的 skill 目录 |
| 加载 | 能解析 `SKILL.md` 的 frontmatter 并读正文 |
| 注入 | 调用 skill 时返回其正文，`${CLAUDE_SKILL_DIR}` 被替换为真实目录 |
| 错误处理 | 请求不存在的 skill 时返回清晰错误 + 可用列表 |

---

## 六、参考文件清单

| 文件 | 用途 |
|------|------|
| `Plan/Backup/src-skills/loadSkillsDir.ts` | 原版目录发现 + SKILL.md 解析 + 条件激活 |
| `Plan/Backup/src-skills/bundledSkills.ts` | 原版 bundled skills 注册与惰性落盘 |
| `Plan/Backup/src-skills/bundled/*.ts` | 原版内置 skills 示例 |
| `Plan/Backup/src-skills/mcpSkillBuilders.ts` | 原版 MCP->skill 桥接（首期不做） |
| `~/.claude/skills/codebase-to-course/SKILL.md` | 真实 SKILL.md 范例 |

---

## 七、开放问题 / 待定

1. **frontmatter 解析**：手写最小解析 vs 引入轻量 YAML 库？当前项目 `zod` 已装，但 YAML 解析器未装。倾向手写支持核心字段。
2. **项目级扫描深度**：向上遍历几层？（MVP 建议 cwd + 一级父目录。）
3. **`list` 触发方式**：用 `skill='list'` 约定 vs schema 增加布尔字段。
4. **是否纳入 `RECONSTRUCTION_PLAN.md` Phase 7 的「精简记忆/技能系统」**：建议在落地方案定稿后，把本计划的 Step 1-5 回填到 Phase 7 勾选项。
