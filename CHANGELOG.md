# Changelog

## 1.0.0 (2026-08-26)

三个独立的「记忆/知识」创新首次同台，标记 1.0：

- **Session Graph Map（NodeMind）** —— 跨会话树状经验图：原生 AI 搜索 + 逻辑树保持，失败路线比成功更有价值。
- **InferMem** —— 跨书知识 DAG：把 markdown 批量编译成带证据的知识图（`concept/definition/theorem/formula/table/case`），跨书按 `identityKey` 合并、`case` 永不合并、原文指针化、隐式边推断、便宜模型批量抽取。
- **TraitGraph** —— 会话级「思维-执行」轨迹图：节点记 `goal/plan/direction`，边记 `action→result`，走不通 `backtrack` 标死折返；模型显式记录，`T{n}` 标记索引（对齐 `S{n}` 索引 raws），Session Memory 可召回注入。

其它：

- 工具增至 16 个（新增 `Infer` / `InferQuery` / `TraitGraph`）。
- 修复 NodeMind Reflector：LLM 吐出纯中文/纯符号 title 时 slug 后 id 为空，导致 `upsertNode` 校验报错——现在容错跳过脏 attr/节点。
