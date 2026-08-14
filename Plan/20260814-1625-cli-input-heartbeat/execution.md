# 执行步骤

## Step 0: 前置验证（先做，决定改动二的实现路径 + 输入边界）

- 探测 Terminal 是否发送 bracketed paste 序列（`ESC[200~`/`ESC[201~`）
- 确认 readline 在 terminal 模式下能否暴露这些序列
- 测超长单行（几万字）的卡顿阈值：readline 逐字符重绘 O(n²) 在多大长度开始卡
- 产出：选定方案 A/B/C，确定输入边界判定方式

## Step 1: 降 `thinking_tick` 心跳

- `query_loop.ts:175` `setInterval(..., 100)` → `1000`

## Step 2: 降工具 `toolTick` 心跳

- `query_loop.ts:105` `setInterval(..., 100)` → `1000`

## Step 3: 降 `pollEvents` 轮询

- `progress.ts:42` `setInterval(..., 80)` → `1000`

## Step 4: （可选）降 `drainTimer`

- `cli.ts:125` `setInterval(..., 100)` → `500`（IME drain 非渲染，单独评估）

## Step 5: 重新设计输入层（按 Step 0 结论）

- 绕过 readline 行编辑，自管 stdin 累积
- 输入边界：回车（短输入）/ bracketed paste 边界（粘贴）/ EOF（超长单行）
- 支持一行几万字 + 粘贴几万行

## Step 6: 编译 + 烟雾测试

```bash
npx tsc --noEmit && npm run build
```

## Step 7: 手动测试 + 记录观察

- 心跳：秒数 1s 一跳，主屏流畅
- 粘贴：5 行 / 几万行完整接收
- 超长单行：一行几万字不卡不丢
- 崩溃：长时间使用观察 Terminal 是否还崩
- 追加 observations.md

## Agent 审查布局（执行前）

按 PLAN_STANDARD，执行前 Agent 集群并行审查：

| Agent | 维度 | 关注点 |
|-------|------|--------|
| Agent 1 | 缺陷分析 | 降频是否影响秒数显示？事件堆积？bracketed paste 的降级路径？ |
| Agent 2 | 模块协调性 | 心跳/轮询/输入三处的调用链是否闭环？tick 合并逻辑在 1Hz 下是否仍成立？ |
