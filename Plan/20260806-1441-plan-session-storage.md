# 会话存储重构 — 完整计划

> **目标**：树文件迁入会话目录，一个会话 = 一个文件夹
> **版本**：v0.5.1 → v0.6.0

---

## 一、存储结构变更

```
旧: ~/.mycoder/                        新: ~/.mycoder/
  sessions/{id}.json           →         sessions/{id}/
  trees/{id}.json              →           session.json       ← 会话
  trees/wal/{id}.wal           →           tree.json          ← 树
  trees/deltas/...             →           wal.jsonl          ← WAL
  trees/archive/...            →           agents/            ← Agent输出（从 team/ 迁入）
  team/{agentId}.txt           →             {agentId}.txt
```

## 二、审查发现的 9 个问题

| # | 严重度 | 问题 | 修复 |
|---|--------|------|------|
| 1 | 🔴 | persist.ts/wal.ts/TreeCmdTool 各自独立构造路径，无共享常量 | 新建 `src/task_tree/paths.ts` 统一导出 |
| 2 | 🔴 | TreeCmdTool.ts:262 硬编码 `trees/` 路径，重构后 list action 静默失效 | 改为从 paths.ts 导入 |
| 3 | 🔴 | wal.ts:31 独立构造 `WAL_DIR`，重构后 WAL 回放与树加载断裂 | 改为从 paths.ts 导入 |
| 4 | 🔴 | 零迁移代码——旧用户数据在新版中完全不可见 | loadTree 加旧格式回退 + 自动迁移 |
| 5 | 🔴 | 并发迁移无锁——两个进程同时启动抢迁移 → EEXIST/ENOENT | mkdir 作为原子锁 |
| 6 | 🟡 | Delta 系统与 WAL 功能重叠，收益极小（树最大 50 节点） | 趁此机会废弃，删 ~80 行 |
| 7 | 🟡 | team 目录未按会话隔离，跨会话 agent 输出混在一起 | 一并迁入 sessions/{id}/agents/ |
| 8 | 🟡 | cleanOldTrees 需同时清理新旧两处（迁移窗口期） | 合并为 cleanOldSessions() |
| 9 | 🟢 | 12+ Plan/*.md 文档引用旧路径 | 运行时不依赖，后期更新 |

## 三、实施

### 新建 1 个文件

**`src/task_tree/paths.ts`**（~20 行）：
```typescript
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = join(homedir(), '.mycoder');
export const SESSIONS_DIR = join(BASE, 'sessions');

export function sessionDir(id: string) { return join(SESSIONS_DIR, id); }
export function sessionPath(id: string) { return join(sessionDir(id), 'session.json'); }
export function treePath(id: string) { return join(sessionDir(id), 'tree.json'); }
export function walPath(id: string) { return join(sessionDir(id), 'wal.jsonl'); }
export function agentDir(id: string) { return join(sessionDir(id), 'agents'); }
export function agentPath(sessionId: string, agentId: string) { return join(agentDir(sessionId), `${agentId}.txt`); }

// 旧格式路径（迁移窗口期使用）
export const OLD_TREE_DIR = join(BASE, 'trees');
export function oldTreePath(id: string) { return join(OLD_TREE_DIR, `${id}.json`); }
export function oldSessionPath(id: string) { return join(SESSIONS_DIR, `${id}.json`); }
```

### 修改 6 个文件

| 文件 | 改动 | 行数 |
|------|------|------|
| `persist.ts` | TREE_DIR → treePath()；loadTree 加旧格式回退+自动迁移；删 delta/archive 代码；cleanOldTrees → cleanOldSessions | +30/-80 |
| `wal.ts` | WAL_DIR → walPath()；cleanOldWals 合并到 cleanOldSessions | +5/-40 |
| `session.ts` | sessionPath() 改为子目录结构；saveSession 加 mkdirSync；listSessions 改为读子目录 | +5/-3 |
| `agent_team.ts` | outputFile → agentPath()；addMember 加 sessionId 参数；cleanOldMembers 合并 | +5/-15 |
| `TreeCmdTool.ts` | list action → 从 paths.ts 导入；删 writeDelta 调用；删硬编码路径 | +5/-10 |
| `Mycoder.ts` | cleanOldTrees+cleanOldWals → cleanOldSessions | +1/-2 |

**净代码量：-40 行**（删 Delta 80 行 > 新增 ~40 行）

## 四、迁移策略

### loadTree 自动迁移

```
loadTree(sessionId):
  1. 新位置 sessions/{id}/tree.json 存在？→ 读，返回
  2. 旧位置 trees/{id}.json 存在？→ 读，saveTree 到新位置，删除旧文件，返回
  3. 都不存在？→ null
```

### 并发安全

```
migrateIfNeeded(id):
  newDir = sessions/{id}/
  mkdirSync(newDir) → 成功？继续迁移
                    → EEXIST？其他进程已抢占 → 等待 tree.json 出现（最多 5s）
```

## 五、执行监督

```
Phase 0: paths.ts 新建 + persist.ts 重构（Agent A，独立）
Phase 1: wal.ts + session.ts + agent_team.ts + TreeCmdTool.ts（4 Agent 并行）
Phase 2: Mycoder.ts 收尾 + 全量编译 + 迁移测试
```

验收：
1. `tsc --noEmit` 零错误
2. 新会话创建：sessions/{id}/ 下有 session.json + tree.json + wal.jsonl + agents/
3. 旧会话自动迁移：trees/{id}.json → sessions/{id}/tree.json
4. list_trees 返回新格式
5. --resume 正常恢复
