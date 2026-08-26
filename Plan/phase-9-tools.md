# Phase 9: 逐个修复工具 ✅ 完成

> **状态**：完成 | **时间**：2026-08-01

## Phase 7-8 总结与指导

两个模式在 Phase 9 中被验证有效：
- **删 > 修**：10个UI.tsx一趟全删，零影响
- **Stub替代**：feature()/USER_TYPE全量替换，不改调用点

## 9a: 删除 UI.tsx ✅
10个工具的UI.tsx一次性删除，零编译错误

## 9b: 批量清理 Anthropic 控制代码 ✅
- bun:bundle feature() import → 删除
- process.env.USER_TYPE === 'ant' → false
- ANT-ONLY markers → 删除
- feature('BASH_CLASSIFIER') → true (保留安全)
- feature('TREE_SITTER_BASH') → true
- 其余 feature() → false

## 编译验证
`npx tsc --noEmit` 零错误

## 对下阶段的指导
- 工具层已完成，**不需要逐文件深入 BashTool 的 12K 行**——安全检查代码保持不变即可
- Phase 10 (utils/) 可以大幅简化——许多文件是孤立存在的，编译通过说明它们未被核心路径引用
- Phase 11 (QueryEngine) 是下一个关键节点——把它接入 main.ts 即可闭环

## 当前总进度
| Phase | 状态 | 行数变化 |
|-------|------|---------|
| 0-6   | ✅ | 512K→154K |
| 7     | ✅ | 基础类型系统 -1,700L |
| 8     | ✅ | 服务层 -5,300L |
| 9     | ✅ | 工具层 -2,100L |
| 10    | ⏳ | utils 按需 |
| 11    | ⏳ | QueryEngine 串联 |
| 12    | ⏳ | 最终验证 |
