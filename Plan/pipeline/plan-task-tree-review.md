# 任务树系统 — 六维度审查报告

> **审查时间**：2026-08-06
> **审查方式**：6 个 Agent 并行审查，分别从交叉冲突、实现风险、性能、遗漏边界、实施成本、架构一致性六个维度
> **审查对象**：任务树系统 20 个风险解决方案（六组 A-F，估算 ~1,579 行）

---

## 审查 1：交叉冲突与依赖

### 发现

**冲突 1 -- TreeWriteLock 与 WAL 初始化顺序**：WAL 重放期间如果有其他异步流程同时读写树会产生竞态。**解决**：启动流程分为单线程初始化阶段（先 activeTree → TreeWriteLock → replayWal）和运行时阶段。

**冲突 2 -- 文件追踪与文件锁双重维护**：两者都维护 file → node/agent 映射但数据结构独立。**解决**：统一为 `fileOwnershipMap`，tracker 和 lock 共享同一数据源。

**冲突 3 -- isSimpleTask 与 decomposeWithValidation 短路顺序**：两者都是"是否分解"判断。**解决**：isSimpleTask 在前（纯启发式，零 LLM 调用），不匹配才走 decomposeWithValidation。

**冲突 4 -- LoopResult 与 preRoundCheck 的 blocked 信号**：preRoundCheck 返回 `"blocked:..."` 后依赖 LLM 理解文本做决策。**解决**：agentLoop 内硬逻辑——preRoundCheck 返回以 `"blocked:"` 开头的事件时直接 break 返回 `{status:'blocked'}`。

**冲突 5 -- checkSubtreeStatus 自动修复与 TreeWriteLock**：修复可能绕过锁直接写树。**解决**：修复必须通过 `TreeWriteLock.batch()`，且修复前检查节点当前状态避免覆盖。

### 依赖图

```
Phase 1（可并行）: types → lock + cascade + persist
Phase 2（依赖 P1）: wal → resume
Phase 3（依赖 P2）: validate + context + file_tracker
Phase 4（依赖 P3）: 集成到 AgentTool + AgentTeamTool
```

最长串行链：lock → wal → resume → AgentTool 集成，约 5-7 天。

---

## 审查 2：实现风险与 Bug 表面

### 风险热力图

| 方案 | 综合风险 | 最高风险点 |
|------|---------|-----------|
| WAL | **9.5/10** | compaction 崩溃在 unlinkSync 和 saveTree 之间→永久数据丢失 |
| TreeWriteLock + 级联 | **8.5/10** | 30s 超时释放锁但原持有者不知情→双持锁 split-brain |
| 启发式 + 树遍历 | **8.0/10** | 复杂任务误判简单 + 循环引用无限递归 |
| LoopResult 变更 | **7.5/10** | 遗漏调用点 + 可选字段 undefined 传播 |
| 校验 + prompt | **7.0/10** | Jaccard 除零 NaN 静默传播 |
| preRoundCheck+depth | **4.0/10** | 最低风险——代码少、逻辑简单 |

### 具体 Bug 场景（Top 5）

1. **WAL compaction crash**（数据丢失）：`unlinkSync(walPath)` 完成后、`saveTree` 执行前 crash → WAL 已删除 + tree 未更新 → 永久丢失。**修复**：先 saveTree（原子 rename），再 unlinkSync WAL。

2. **TreeWriteLock 超时双持锁**：Agent-X 持锁超时→锁被释放→Agent-Z 获取锁→Agent-X 仍在写树（它不知道自己被剥夺了锁）。**修复**：超时时触发 holder 的 abortController。

3. **级联终止 50 节点性能**：串行递归 abort（每个 200ms）= 10 秒，超 TreeWriteLock 的 30s 还好但可能触发其他问题。**修复**：BFS + 并发度 10 + `Promise.allSettled`。

4. **Jaccard 除零 NaN**：`context.files` 为空数组时 `0/0 = NaN`，`NaN > 0.8 = false`，校验永远不通过。**修复**：`union.size === 0` 时返回 0。

5. **LoopResult 遗漏调用点**：agentLoop 返回类型从 `string` 改 `LoopResult`，测试 mock、插件、动态 import 处的调用可能遗漏。**检测**：`grep -rn "agentLoop(" src/ test/` + runtime trace。

---

## 审查 3：性能与延迟

### MVP 每轮新增开销

| 组件 | 单次耗时 | 25轮累计 | 占比 LLM 延迟 |
|------|---------|---------|--------------|
| preRoundCheck 遍历 tasks Map | ~0.15ms | ~3.75ms | 0.02% |
| 300词截断（摊销） | ~0.002ms | ~0.05ms | ~0% |
| LoopResult 封装 | ~0.00005ms | ~0.00005ms | ~0% |
| **合计** | **~0.15ms/轮** | **~3.8ms** | **0.02%-0.2%** |

### 砍掉的组件对比

| 被砍组件 | 每轮开销 | 25轮累计 |
|---------|---------|---------|
| WAL（appendFileSync × 5 状态变更） | ~5ms | **+125ms** |
| Delta 增量写入（writeFileSync × 3） | ~3ms | **+75ms** |
| 层次化摘要（递归 + 注入 context） | ~0.5ms | +12.5ms |
| **全保留方案** | **~8.65ms/轮** | **~216ms** |

### 启动延迟

cleanOldTrees + cleanOldWals + 标 failed running 节点 + loadTree = **~29ms**（用户不可感知）。

### 内存

lastKnownStates Map（~5KB）+ activeTree 50节点（~17KB）= **~22.5KB**（V8 堆的 0.01%）。

---

## 审查 4：遗漏边界与未覆盖场景

### 补充风险清单（原方案未覆盖的）

| 优先级 | 场景 | 严重性 | 解决方案 |
|--------|------|--------|---------|
| P0 | renameSync EXDEV 跨文件系统 | 数据丢失 | try-catch + copyFileSync fallback |
| P0 | Supervisor 被 kill → Worker 孤儿结果 | 已完成工作丢弃 | cascadeKillTreeNode 收集已完成子节点结果 |
| P1 | Worker [DONE] hallucination 无二次验证 | 错误结果被接受 | Supervisor prompt 加 Read 验证指引 |
| P1 | system prompt 动态部分破坏 Anthropic cache | 成本 ~3x | CWD/Date 移到首条 user message |
| P1 | 崩溃恢复后文件锁全部丢失 | 双写风险 | SessionData 加 fileLocks 快照 |
| P2 | ConcurrencyLimiter 排队期间 preRoundCheck 空转 | 无正确性问题 | 可忽略或挪到 acquire 之后 |
| P2 | LLM hallucinate AgentTool（工具列表里无此工具） | 浪费轮次 | Worker prompt 显式声明"你没有 Agent 工具" |
| P3 | cleanOldTrees 文件被 Finder 锁定→静默 skip | 磁盘渐进增长 | console.warn 输出被跳过文件 |

### 资源竞争

- **全局数组 recordFileOps**：改为写入 agent_team 的 outputFile（per-agent 隔离），避免并发竞态
- **TreeWriteLock 单进程假设**：当前 OK，未来多进程时需加 lockfile wx 标志
- **预写日志同步 I/O**：compaction 阈值 50 条 + 可选异步 append

---

## 审查 5：实施成本与集成复杂度

### 代码量重估

| 估算类型 | 行数 |
|---------|------|
| 原方案乐观估算 | ~1,579 |
| 实际乐观（含类型/import/注释） | ~2,200 |
| 实际悲观（含两轮重构） | ~3,000 |
| **合理预期** | **~1,480**（模块化拆分后，样板代码减少） |

### 集成难度排序

| 文件 | 难度 | 原因 |
|------|------|------|
| task_tree 目录（新建） | 5/10 | 全新建，无历史负担 |
| AgentTool.ts | **10/10** | 神经中枢——每次 agent 调用都经过 |
| session_loop.ts（LoopResult） | **9/10** | **单向门**——破坏性变更，所有调用点必须适配 |
| agent_def.ts（prompt 分层） | 7/10 | 多方案 prompt 片段的组合可能产生意外行为 |
| AgentTeamTool.ts | 6/10 | 状态分级新增判断逻辑 |
| Mycoder.ts（启动流程） | 3/10 | 几行初始化 |
| session.ts + cli.ts | 2/10 | 纯字段新增 + 适配 |

### 实施周期

| Phase | 内容 | 时间 |
|-------|------|------|
| 0 | 类型与接口 | 1-2 天 |
| 1 | 核心引擎（types/core/lock/persist/wal/cascade） | 3-5 天 |
| 2 | LoopResult 变更 + agentLoop 适配 | 2-3 天 |
| 3 | AgentTool/AgentTeam 集成 + TreeCmdTool | 3-4 天 |
| 4 | 校验与恢复（validate/context/file_tracker/resume） | 2-3 天 |
| 5 | 提示词与打磨 | 2-4 天 |
| **合计** | | **4-6 周** |

### 回滚风险

- **单向门**：LoopResult 变更——最先做、独立 PR、最小变更面
- **可回滚**：feature flag 包裹（prompt 片段、工具注册、校验函数），出问题一键关闭
- **原则**：永不把单向门和可回滚改动放在同一个 PR

---

## 审查 6：架构一致性

### 设计哲学审查

**LLM 自主决策 vs 硬约束**：大部分硬约束是安全栏杆（circuit breaker）而非决策替代。关键区分——安全栏杆放在 LLM 输出之后（post-hoc validation），而非 LLM 输入之前（prompt constraint）。

**失败处理**：decomposeWithValidation 的"失败→修正→fallback"与 replaceSubtree 一致，因为 fallback 本身就是一棵新的更简单的子树。修正不是 retry，是用不同输入产出不同输出。

**层次封装**：context.files 冲突检测应由 Supervisor 聚合（向下注入约束），而非 Worker 自查（跨层感知）。Supervisor 已有所有子节点信息，不需要 Worker 查询全局状态。

### 复杂度预算

- task_tree/ 目录（10 文件）：~1,300 行
- 现有文件改动：~180 行
- **合计**：~1,480 行
- 当前代码量：~2,453 行
- **增幅**：~60%

警示：60% 增幅不低。但拆分 10 个文件后单文件平均 130 行，每个职责清晰，维护成本受控。

### 与 Claude Code 的比较

| 维度 | Claude Code | 我们的设计 | 差异原因 |
|------|------------|-----------|---------|
| 任务状态持久化 | LLM 上下文窗口内 | 显式树 + WAL + JSON | 目标模型（DeepSeek）规划能力弱于 Claude |
| 崩溃恢复 | LLM 重读已有产物自行判断 | WAL 回放 + 自动修复 | 同上 + 会话恢复是显式需求 |
| 文件冲突 | Worktree 隔离 | context.files 声明 + 冲突检测 | 无 worktree 机制 |
| 子 Agent 创建 | Fork 继承完整上下文（零开销） | 从零创建（有开销但可控） | Prompt cache 不可用 |
| 基础设施厚度 | 极薄（queryLoop + 工具系统） | 较厚（树/锁/WAL/追踪） | 哲学差异：信任 LLM vs 辅助 LLM |

### 最终建议

**保留全部功能**（用户要求），但通过模块化拆分达到清晰优雅：
- 每个文件 < 200 行，职责单一
- 依赖反转解决循环引用
- 分层 prompt 防止膨胀
- Feature flag 机制支持渐进启用

**核心原则**：
1. LLM 是决策者，基础设施是安全网
2. 崩溃恢复靠 LLM 判断 + WAL 双重保障
3. "容忍 + 验证"优于"阻止"——冲突先通知 LLM，由 LLM 决定
4. 复杂度分散到小文件，而非集中到一个大文件

---

## 附录：审查 Agent 统计

| # | 审查维度 | 用时 | 消耗 token |
|---|---------|------|-----------|
| 1 | 交叉冲突与依赖 | ~91s | ~31,500 |
| 2 | 实现风险与 Bug 表面 | ~128s | ~31,200 |
| 3 | 性能与延迟 | ~122s | ~80,600 |
| 4 | 遗漏边界与未覆盖场景 | ~104s | ~77,500 |
| 5 | 实施成本与集成复杂度 | ~60s | ~31,300 |
| 6 | 架构一致性 | ~140s | ~64,300 |
| **合计** | | **~645s** | **~316,400** |
