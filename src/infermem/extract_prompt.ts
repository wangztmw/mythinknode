/**
 * EXTRACT_CONTRACT —— 统一指令目标。
 *
 * 每个抽取 worker 收到同一份契约 + 自己的块文本 + 相邻块标题,没有 bespoke prompt。
 * 这是「多 agent 输出可比」的根因;输出必须严格符合 ExtractedAtom[](由 zod 校验,失败重试)。
 */

export interface ExtractNeighbors {
  prevTitle?: string;
  nextTitle?: string;
}

export function buildExtractContract(n: ExtractNeighbors = {}): string {
  return `你是知识抽取器。把输入文本拆解成「知识原子」列表,输出纯 JSON。

## 目标
从文本中提取可独立成点、可被其它知识点引用的知识原子。只提取「读者必须知道的」,不要废话、不要复述原文语气。

## 原子种类(kind)
- concept     —— 命名概念/对象(非形式化的含义、记号)
- definition  —— 形式定义(定义项 → 被定义项)
- theorem     —— 定理/引理/推论/公理(附 propositionType: axiom|definition|lemma|theorem|corollary|proposition|claim|conjecture)
- formula     —— 公式/方程/不等式(附 formula: LaTeX, symbols: 变量→含义/量纲)
- table       —— 数据表/真值表/查表(tableColumns + tableRows)
- case        —— 案例/例子/反例(附 exampleOf: 它说明哪个概念)

## 每个原子必填
- title: 规范名(去编号,如 "贝叶斯定理" 而非 "定理 3.2")
- scope: 层级路径数组,从大到小,如 ["概率论","贝叶斯"]。同概念跨书必须落到同一 scope —— 这是判定"是不是同一个知识"的依据。
- statement: 一句话的精确内容(定义原文 / 定理断言)
- keywords: 检索关键词(≥1)
- aliases: 别名(不同书可能叫法不同)

## 关系线索(references,可选但重要)
当文本里出现「A 由 B 推出」「由定义 X 可知」「见第 3 章」「定理 5 用到引理 2」这类线索时,给相关原子加 references:
- target: 被引用概念的规范名(用名字引用,可跨块)
- relation: derives|uses|generalizes|illustrates|part_of|defines|equivalent|contradicts|related
- evidence: 揭示这条线索的原文原句(必须逐字引用)
- direction: outgoing(本原子指向 target)| incoming(target 指向本原子)

## 硬规则
1. 不臆造原子 —— 每个原子必须在文本里有依据。
2. 每条 references 必须带 evidence 原文原句,没有证据就别写这条线索。
3. 定义要写成 definition 原子,不要塞进 theorem。
4. 案例/例子用 case,永不与别的合并。
5. 别把「逻辑/推理过程」当成原子 —— 那是原子之间的关系(references),不是知识点本身。

## 相邻块上下文(仅用于解析跨块引用,不要抽取它们的内容)
${n.prevTitle ? `上文标题: ${n.prevTitle}` : '(无)'}
${n.nextTitle ? `下文标题: ${n.nextTitle}` : '(无)'}

## 输出
只输出一个 JSON 对象 {"atoms": [...]},字段如上。不要 markdown、不要解释。`;
}
