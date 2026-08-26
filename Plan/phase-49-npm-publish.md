# Phase 49 计划：NPM 发布准备

> **创建时间**：2026-08-02
> **状态**：✅ 已实施并验证完成（2026-08-02）
> **目标**：让 my-coder 可以通过 `npm i -g my-coder && mycoder` 在任何电脑上使用
> **原则**：先完善，再发布。不急——先把该做的事情想清楚、做干净。

---

## 一、发布前检查清单

### 第一档：阻塞项（不完成无法发布或发布了不能用）

| # | 项目 | 现状 | 目标 |
|---|------|------|------|
| 1 | **README.md** | ❌ 不存在 | 写清：是什么、怎么装、怎么配 API key、支持什么 |
| 2 | **bin 字段** | ❌ 无 | `"bin": { "mycoder": "dist/Mycoder.js" }` |
| 3 | **Shebang** | ❌ 无 | `dist/Mycoder.js` 顶部加 `#!/usr/bin/env node` |
| 4 | **engines 字段** | ❌ 无 | `"engines": { "node": ">=18" }`（用了 fetch + ESM） |
| 5 | **files 字段** | ❌ 无 | `"files": ["dist/"]`（防止 Plan/Backup 被打进 npm） |
| 6 | **private: true** | ❌ 阻止发布 | 改为 `false` 或删除 |
| 7 | **版本号统一** | 横幅 v0.4.0，package.json 0.1.0 | 统一为 `0.4.0` |
| 8 | **dist 干净重建** | `dist/main.js` 残留 | `rm -rf dist && npm run build` |

### 第二档：体验项（提升健壮性，不阻塞发布）

| # | 项目 | 现状 | 目标 |
|---|------|------|------|
| 9 | **tsconfig include 范围** | `["src/Mycoder.ts", "src/tools-v2/**/*.ts"]` | `["src/**/*.ts"]`（显式包含 agent/cli/config 等新文件） |
| 10 | **zod 版本** | `^3.24.0` → 代码用 `zod/v4` 子路径 | `"zod": "~4.4.0"`（v4 才有 /v4 导出） |
| 11 | **多余依赖清理** | `lodash-es`、`@anthropic-ai/sdk`、`@modelcontextprotocol/sdk`、`p-map` 实际未使用 | 移除未使用的依赖 → 只剩 zod 一个 |
| 12 | **package-lock.json** | 旧版含 5 个依赖的锁文件 | 重装后 -1,200 行 |

### 第三档：发布后验证（发布完成后执行）

| # | 验证 | 方法 |
|---|------|------|
| 12 | 全局安装可用 | `npm i -g my-coder && mycoder` |
| 13 | npx 可用 | `npx my-coder` |
| 14 | 新机器场景 | 仅设 `MYCODER_API_KEY`，启动后 model/provider 自动持久化到 `~/.mycoder.json` |

---

## 二、每项的具体改动

### 1. README.md（新建）

需要覆盖的章节：
- 标题 + 一句话描述
- 安装（`npm i -g my-coder`）
- 配置 API key（环境变量 `MYCODER_API_KEY` 或 `ANTHROPIC_API_KEY`）
- 基本使用（`mycoder` 启动 → 输入问题 → `/exit` 退出）
- 支持的工具列表（12 个）
- 配置文件说明（`~/.mycoder.json`、`~/.mycoder/MYCODER.md`）

### 2. bin + shebang

**package.json**：
```json
"bin": { "mycoder": "dist/Mycoder.js" }
```

**Shebang**：由于 TypeScript 编译器不会自动加 shebang，需要在构建后手动加。两种方案：
- 方案 A：构建脚本里用 `sed` 在 `dist/Mycoder.js` 头部插入 `#!/usr/bin/env node`
- 方案 B：单独写一个 `bin/mycoder.js` 包装脚本

选择 **方案 B**——更干净，不需要改构建流程：
```js
#!/usr/bin/env node
import '../dist/Mycoder.js';
```

不对，这样会有路径问题。让我用方案 A——在 `package.json` 的 `build` 脚本后追加 shebang：

```json
"scripts": {
  "build": "tsc && node -e \"const fs=require('fs');const f='dist/Mycoder.js';fs.writeFileSync(f,'#!/usr/bin/env node\\n'+fs.readFileSync(f,'utf8'))\"",
  ...
}
```

不过这段代码可读性差。最简单的方式是写一个小脚本 `scripts/add-shebang.js`。

但为了保持零外部工具依赖的简洁性，直接用简单的方式：

```json
"scripts": {
  "build": "tsc && printf '#!/usr/bin/env node\\n%s\\n' \"$(cat dist/Mycoder.js)\" > dist/Mycoder.js",
  ...
}
```

嗯，`printf` 在 macOS 上行为可能不一致。让我用最简单的 Node 一行:

```json
"scripts": {
  "build": "tsc && node -e \"var f=require('fs');var c=f.readFileSync('dist/Mycoder.js','utf8');f.writeFileSync('dist/Mycoder.js','#!/usr/bin/env node\\n'+c)\"",
  ...
}
```

这样不行，因为 package.json 是 `"type": "module"`，`require` 不可用。而且 ESM 的 `node -e` 也用不了 `require`。

那用方案 B——单独写一个简单的包装文件 `bin/mycoder.js`：

```js
#!/usr/bin/env node
import '../dist/Mycoder.js';
```

然后 `"bin": { "mycoder": "bin/mycoder.js" }`。

但这个 import 的路径是相对于 `bin/mycoder.js` 的，`../dist/Mycoder.js` 在安装后应该能正确解析。

实际上还有个更简单的方法：Node 的 `--import` 或直接用 `node dist/Mycoder.js` 作为 bin。但 npm bin 字段要求文件有 shebang。

最简单可靠的做法：写一个 bin 包装脚本。

```json
"bin": { "mycoder": "bin/mycoder.js" }
```

`bin/mycoder.js`:
```js
#!/usr/bin/env node
import('../dist/Mycoder.js');
```

动态 import 返回 promise，但 `Mycoder.js` 里已经有 `main().catch(console.error)` 是自执行的，所以没事。

### 3. engines

```json
"engines": { "node": ">=18" }
```

理由：用了 `fetch`（Node 18+）、ESM（`"type": "module"`）、top-level await。

### 4. files

```json
"files": ["dist/", "bin/", "README.md", "LICENSE"]
```

只发布运行需要的文件。`src/` 和 `Plan/` 不进包。

### 5. private

删除 `"private": true`。

### 6. 版本号

`"version": "0.4.0"` —— 与横幅对齐。

### 7. dist 清理

```bash
rm -rf dist
npm run build
```

### 9. tsconfig include

```json
"include": ["src/**/*.ts"]
```

### 10. zod 锁定

```json
"zod": "~3.24.0"
```

然后 `npm install` 更新 lockfile。

### 11. 依赖清理

检查实际使用情况：
- `@anthropic-ai/sdk`：代码中用 `fetch` 直接调 Anthropic API，**没用这个包** → 删除
- `@modelcontextprotocol/sdk`：MCPTool 是 stub，**未实际使用** → 删除
- `lodash-es`：代码中未 import → 删除
- `p-map`：代码中未 import → 删除

只保留 `zod`。

---

## 三、最终 package.json 预览

```json
{
  "name": "my-coder",
  "version": "0.4.0",
  "description": "Minimal AI coding agent — stripped, independent, research-grade",
  "type": "module",
  "main": "dist/Mycoder.js",
  "bin": { "mycoder": "bin/mycoder.js" },
  "files": ["dist/", "bin/", "README.md"],
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/Mycoder.js",
    "dev": "npx tsx src/Mycoder.ts"
  },
  "dependencies": {
    "zod": "~3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

依赖从 5 个减到 **1 个**（zod）。

---

## 四、不做的事（明确边界）

| 不做 | 原因 |
|------|------|
| 实际执行 `npm publish` | 本 Phase 只准备，发布由你决定时机 |
| 添加 LICENSE 文件 | 你自行选择许可证 |
| CI/CD 自动发布 | 后续 Phase |
| 语义版本自动化 | 后续 Phase |
| `.npmignore` | 用 `files` 白名单更安全（不会漏加） |

---

## 五、实施步骤

```
Step 1:  写 README.md
Step 2:  创建 bin/mycoder.js 包装脚本
Step 3:  更新 tsconfig.json（include + zod 版本）
Step 4:  重写 package.json（版本/bin/files/engines/private/依赖清理）
Step 5:  npm install（更新 lockfile）
Step 6:  rm -rf dist && npm run build
Step 7:  npx tsc --noEmit 验证
Step 8:  冒烟测试（/help + /exit）
Step 9:  npm pack --dry-run 预览
Step 10: git commit + push
```

---

## 六、实施清单

- [x] Step 1: 写 README.md（安装/配置/使用/架构，~80 行）
- [x] Step 2: 创建 `bin/mycoder.js`（shebang + 动态 import）
- [x] Step 3: 更新 tsconfig.json（include: `src/**/*.ts`）
- [x] Step 4: 重写 package.json（版本/bin/files/engines/依赖瘦身）
- [x] Step 5: `npm install` 更新 lockfile（zod ~4.4.0，删 4 个孤儿依赖，lockfile -1,200 行）
- [x] Step 6: `rm -rf dist && npm run build`
- [x] Step 7: `npx tsc --noEmit` 零错误 ✅
- [x] Step 8: 冒烟测试（/help + /exit）✅
- [x] Step 9: `npm pack --dry-run` 验证（23.2 kB 压缩 / 75.1 kB 解压 / 39 文件 / 零源码泄露）✅
- [x] Step 10: git commit + push

### 验证结果

| 测试 | 结果 |
|------|------|
| TypeScript 编译 | ✅ 零错误 |
| /help + /exit | ✅ 正常 |
| npm pack --dry-run | ✅ 23.2 kB，39 文件，无 src/Plan/Backup |
| 依赖数量 | ✅ 5 → 1（仅 zod） |
