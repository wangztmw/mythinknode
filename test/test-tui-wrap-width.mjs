// TUI 渲染宽度回归：任何日志行都不得超过终端列宽
//
// 用法: node Plan/cli-test/test-tui-wrap-width.mjs（需先 npm run build）
//
// ## 为什么需要这个测试
//
// 日志列表跑在 Ink 的 <Static> 里，而 Static 的容器是 `position: absolute` 且没有
// width —— Yoga 会按内容撑开它。于是 `flexGrow={1}` 的子项拿到的是「终端宽度」
// 而不是「终端宽度 - 前缀」，导致每行宽出前缀长度（80 列终端渲染成 82 列）。
// 终端再折一次，用户看到的就是「屏幕没满就断」的奇怪折行。
//
// 这类 bug 有两个特点，决定了测试必须这么写：
//   1. 单看代码完全正常（flexGrow 在普通容器里是对的）；
//   2. 只有真实走 Ink 的布局+折行才能暴露（不能测 wrapLines 纯函数）。
// 所以本测试用真实 Ink render + 可控列数的假 stdout，逐字节比对宽度。
import { EventEmitter } from 'node:events';

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const React = (await import('react')).default;
const { render } = await import('ink');
const D = new URL('../dist/', import.meta.url).pathname;

const { TuiStore } = await import(D + 'cli/tui/store.js');
const { SessionApp } = await import(D + 'cli/tui/SessionApp.js');
const { WindowSizeProvider } = await import(D + 'cli/tui/layout/window-size.js');

/** 假 stdout：列数可控，缓冲全部输出 */
class FakeStdout extends EventEmitter {
  constructor(columns, rows = 40) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = true;
    this.buf = '';
  }
  write(s) { this.buf += s; return true; }
}

/**
 * 假 stdin：SessionApp 的 useInput 需要 raw mode，否则 Ink 抛错并把
 * 大量堆栈写进输出，污染断言。给它一个最小可用实现。
 */
class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.rawMode = false;
  }
  setRawMode(v) { this.rawMode = v; return this; }
  setEncoding() { return this; }
  resume() { return this; }
  pause() { return this; }
  ref() { return this; }
  unref() { return this; }
  read() { return null; }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07]*\x07/g;
const strip = (s) => s.replace(OSC, '').replace(ANSI, '');

/** 显示宽度：CJK / 全角算 2 列 */
const displayWidth = (line) => {
  let w = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    const wide = (cp >= 0x1100 && cp <= 0x115f)
      || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x1f300 && cp <= 0x1f9ff);
    w += wide ? 2 : 1;
  }
  return w;
};

/** 渲染一组 items，返回去 ANSI 后的原始行（保留空白行，用于检查占位） */
async function renderItemsRaw(items, columns) {
  const stdout = new FakeStdout(columns);
  const stderr = new FakeStdout(columns);
  const stdin = new FakeStdin();
  const store = new TuiStore();
  if (items.length) store.appendBatch(items);

  const tree = React.createElement(
    WindowSizeProvider,
    null,
    React.createElement(SessionApp, { store }),
  );
  const inst = render(tree, {
    stdout, stderr, stdin,
    debug: false, patchConsole: false, exitOnCtrlC: false,
  });
  await new Promise(r => setTimeout(r, 320));
  inst.unmount();
  await new Promise(r => setTimeout(r, 80));

  return strip(stdout.buf).split('\n');
}

/** 渲染一组 items，返回去 ANSI 后的所有非空行 */
async function renderItems(items, columns) {
  return (await renderItemsRaw(items, columns)).filter(l => l.trim().length > 0);
}

// ============================================================
console.log('\n=== 1. 用户消息：各宽度下不溢出 ===\n');
// ============================================================
const ZH = '我们现在有一个小的体验优化，我之前是做了一输出渲染重定义，让大模型返回内容按屏幕尺寸渲染宽度，我发现有个漏洞就是我的消息发给大模型之后也会在屏幕上渲染，之前为了不让屏幕崩溃用了硬性折行';
const EN = 'We now have a small UX improvement. I previously redefined the output rendering so that model responses wrap according to screen width and it looked wrong.';
const MIX = '这是 mixed 中英文 text 测试 wrap 行为，还要包含 supercalifragilisticexpialidocious 这种超长单词。';
const MULTI = '第一行内容\n第二行内容\n\n第四行（第三行是空行）';

for (const cols of [40, 60, 80, 100, 120]) {
  for (const [name, text] of [['中文', ZH], ['英文', EN], ['混合', MIX], ['多行', MULTI]]) {
    const lines = await renderItems([{ kind: 'user', text }], cols);
    const over = lines.filter(l => displayWidth(l) > cols);
    assert(`${cols}列 用户消息(${name}) 不溢出`, over.length === 0,
      over.slice(0, 2).map(l => `[${displayWidth(l)}]${l.slice(0, 40)}`).join(' | '));
  }
}

// ============================================================
console.log('\n=== 2. 用户消息：续行缩进对齐 ===\n');
// ============================================================
{
  const lines = await renderItems([{ kind: 'user', text: ZH }], 80);
  assert('中文长句产生多行', lines.length >= 2, `${lines.length} 行`);
  if (lines.length >= 2) {
    assert('首行以 "> " 开头', lines[0].startsWith('>'), JSON.stringify(lines[0].slice(0, 10)));
    assert('续行以两个空格开头（对齐正文）', lines[1].startsWith('  ') && !lines[1].startsWith('> '),
      JSON.stringify(lines[1].slice(0, 10)));
    assert('续行缩进恰好 2 列（不是 1 也不是 3）',
      /^ {2}\S/.test(lines[1]) && !lines[1].startsWith('   '),
      JSON.stringify(lines[1].slice(0, 12)));
  }

  const enLines = await renderItems([{ kind: 'user', text: EN }], 80);
  if (enLines.length >= 2) {
    assert('英文续行同样缩进 2 列', /^ {2}\S/.test(enLines[1]), JSON.stringify(enLines[1].slice(0, 12)));
    // 英文必须按词折行。判据：渲染结果里每个长英文 token 在**原文**中都是完整单词
    // （前后都不是字母）。
    // ⚠️ 不能用「行末有无尾随空格」判断 —— Ink 渲染时会 trimEnd()，
    // wrap-ansi 保留的那个空格在最终输出里已经没了（踩过一次）。
    // ⚠️ 只检查**日志区**：输入框常驻后，提示行（Enter 发送 / Ctrl+U …）也在同一帧里，
    // 其中的 English token 会污染本断言（2026-11-14 踩过一次）。
    const uiStart = enLines.findIndex(l => l.includes('╭') || l.includes('›'));
    const msgLines = uiStart > 0 ? enLines.slice(0, uiStart) : enLines;
    const broken = [];
    for (const line of msgLines) {
      for (const tok of line.match(/[A-Za-z]{4,}/g) ?? []) {
        // 在原文里找这个 token 的所有出现位置，看有没有一次是「完整单词」
        let at = -1;
        let whole = false;
        while ((at = EN.indexOf(tok, at + 1)) !== -1) {
          const before = EN[at - 1];
          const after = EN[at + tok.length];
          if (!/[A-Za-z]/.test(before ?? ' ') && !/[A-Za-z]/.test(after ?? ' ')) { whole = true; break; }
        }
        if (!whole) broken.push(tok);
      }
    }
    assert('英文按词折行（没有半截单词）', broken.length === 0, broken.slice(0, 5).join(', '));
  }
}

// ============================================================
console.log('\n=== 3. 用户消息：多行输入的空白行不被吞 ===\n');
// ============================================================
{
  // 多行输入中间的空行必须占一行（否则上下两段会粘在一起）。
  // ⚠️ renderItems 会过滤纯空白行，所以这里单独取「未过滤」的行来检查占位。
  const lines = await renderItems([{ kind: 'user', text: MULTI }], 80);
  assert('三行非空内容全部渲染', lines.filter(l => /第一行|第二行|第四行/.test(l)).length === 3,
    `${lines.length} 行: ${lines.map(l => l.trim().slice(0, 8)).join(' / ')}`);

  const raw = await renderItemsRaw([{ kind: 'user', text: MULTI }], 80);
  const i2 = raw.findIndex(l => l.includes('第二行'));
  const i4 = raw.findIndex(l => l.includes('第四行'));
  assert('第二行与第四行之间隔着恰好一行', i2 >= 0 && i4 === i2 + 2, `第二行@${i2} 第四行@${i4}`);
  assert('中间那一行是空白占位（不是被吞掉）',
    i2 >= 0 && i4 === i2 + 2 && raw[i2 + 1].trim() === '',
    JSON.stringify(raw[i2 + 1]));
}

// ============================================================
console.log('\n=== 4. 其他渲染分支：各宽度下不溢出 ===\n');
// ============================================================
const itemCases = [
  ['md-段落中文', { kind: 'md', text: ZH }],
  ['md-段落英文', { kind: 'md', text: EN }],
  ['md-混合', { kind: 'md', text: MIX }],
  ['md-标题', { kind: 'md', text: '## ' + EN }],
  ['md-列表', { kind: 'md', text: '- ' + ZH + '\n- ' + EN }],
  ['md-引用', { kind: 'md', text: '> ' + ZH }],
  ['md-代码', { kind: 'md', text: '```ts\nconst x = "' + EN + '";\n```' }],
  ['md-表格', { kind: 'md', text: '| 列一 | 列二 |\n|---|---|\n| ' + ZH.slice(0, 20) + ' | ' + EN.slice(0, 40) + ' |' }],
  ['system', { kind: 'system', text: ZH }],
  ['error', { kind: 'error', text: ZH }],
  ['tool', { kind: 'tool', text: 'Bash', meta: { name: 'Bash', args: ZH } }],
  ['toolResult', { kind: 'toolResult', text: ZH, meta: { totalLines: 1, shownLines: 1, truncated: false } }],
  ['thought', { kind: 'thought', text: ZH, meta: { totalLines: 1, shownLines: 1, truncated: false } }],
  ['help', { kind: 'help', text: ZH }],
];

for (const cols of [40, 60, 80, 100, 120]) {
  for (const [name, item] of itemCases) {
    const lines = await renderItems([item], cols);
    const over = lines.filter(l => displayWidth(l) > cols);
    assert(`${cols}列 ${name} 不溢出`, over.length === 0,
      over.slice(0, 2).map(l => `[${displayWidth(l)}]${l.slice(0, 40)}`).join(' | '));
  }
}

// ============================================================
console.log('\n=== 5. 极端输入 ===\n');
// ============================================================
{
  const long = 'a'.repeat(300);
  for (const cols of [40, 80]) {
    const lines = await renderItems([{ kind: 'user', text: long }], cols);
    assert(`${cols}列 300 字符无空格串不溢出`, lines.every(l => displayWidth(l) <= cols),
      lines.map(l => displayWidth(l)).join(','));
    assert(`${cols}列 300 字符无空格串被硬断（多行）`, lines.length > 1, `${lines.length} 行`);
  }

  // 中英混排 + 标点（避头尾场景）
  const punct = '他说：「这个功能很好用。」然后继续写代码，测试一下。'.repeat(3);
  const pl = await renderItems([{ kind: 'user', text: punct }], 60);
  assert('60列 中文标点长句不溢出', pl.every(l => displayWidth(l) <= 60),
    pl.map(l => displayWidth(l)).join(','));

  // emoji（宽度按 2 算）
  const emoji = '测试 emoji 宽度 🎯🚀🔥🎉 是否算对'.repeat(3);
  const el = await renderItems([{ kind: 'user', text: emoji }], 60);
  assert('60列 emoji 行不溢出', el.every(l => displayWidth(l) <= 60),
    el.map(l => displayWidth(l)).join(','));
}

// ============================================================
console.log('\n=== 6. 结构：不该再用 flexGrow 承载宽度 ===\n');
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const SRC = new URL('../src/', import.meta.url).pathname;
  const codeOf = (p) => readFileSync(SRC + p, 'utf8')
    .split('\n')
    .filter(l => { const t = l.trim(); return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); })
    .join('\n');

  const app = codeOf('cli/tui/SessionApp.tsx');
  assert('用户消息不再用 flexGrow 承载宽度', !/case 'user':[\s\S]{0,300}flexGrow/.test(app));
  assert('用户消息用 contentWidth() 算宽度', /contentWidth = contentWidthOf\(columns, 2\)/.test(app));
  assert('用户消息用 wrapLines 显式折行', /wrapLines\(item\.text, contentWidth\)/.test(app));

  const md = codeOf('cli/tui/render/markdown.tsx');
  const flexGrowLeft = (md.match(/flexGrow=\{[^}]*\}/g) ?? []).length;
  assert('markdown 里不再有 flexGrow 承载内容宽度', flexGrowLeft === 0,
    `还剩 ${flexGrowLeft} 处`);
  assert('row() 用 width={contentWidth}', /<Box width=\{contentWidth\} flexDirection="column">\{content\}<\/Box>/.test(md)
    || /width=\{contentWidth\}/.test(md));

  // 全仓不该再有 `Math.max(10, columns - N)` 这种会越界的兜底
  const { execSync } = await import('node:child_process');
  const hits = execSync(
    `grep -rn "Math.max(10, columns\\|Math.max(4, columns\\|Math.max(10, size" src/cli/tui/ || true`,
    { encoding: 'utf8' },
  ).split('\n').filter(l => l.trim() && !l.trim().startsWith('src/cli/tui/text/width.ts:'));
  assert('全仓不再用 Math.max(10, columns - N) 兜底宽度', hits.length === 0,
    hits.slice(0, 3).join(' | '));
}

// ============================================================
console.log('\n=== 7. contentWidth() 不变式 ===\n');
// ============================================================
{
  const { contentWidth } = await import(D + 'cli/tui/text/width.js');

  // 核心不变式：恒 ≤ max(1, columns - reserved)，且恒 ≥ 1
  let violations = [];
  for (let cols = 1; cols <= 200; cols++) {
    for (let reserved = 0; reserved <= 10; reserved++) {
      const got = contentWidth(cols, reserved);
      const maxAllowed = Math.max(1, cols - reserved);
      if (got > maxAllowed) violations.push(`columns=${cols} reserved=${reserved} → ${got} > ${maxAllowed}`);
      if (got < 1) violations.push(`columns=${cols} reserved=${reserved} → ${got} < 1`);
    }
  }
  assert('columns 1..200 × reserved 0..10 全部不越界且 ≥ 1', violations.length === 0,
    violations.slice(0, 3).join(' | '));

  // 旧写法在这个范围里会越界（反证这条不变式不是空转）
  const old = (cols, reserved) => Math.max(10, cols - reserved);
  const oldViolations = [];
  for (let cols = 1; cols <= 200; cols++) {
    for (let reserved = 0; reserved <= 10; reserved++) {
      if (old(cols, reserved) > Math.max(1, cols - reserved)) oldViolations.push(`${cols}/${reserved}`);
    }
  }
  assert('旧写法 Math.max(10, ...) 确实会越界（证明这条断言有效）', oldViolations.length > 0,
    `${oldViolations.length} 个组合越界`);

  // 正常宽度下两写法等价（保证没有回归）
  const same = [];
  for (let cols = 20; cols <= 200; cols++) {
    for (let reserved = 0; reserved <= 10; reserved++) {
      if (contentWidth(cols, reserved) !== old(cols, reserved)) same.push(`${cols}/${reserved}`);
    }
  }
  assert('columns ≥ 20 时与旧写法完全等价（无回归）', same.length === 0,
    same.slice(0, 3).join(' | '));

  assert('contentWidth(80, 2) === 78', contentWidth(80, 2) === 78, String(contentWidth(80, 2)));
  assert('contentWidth(8, 2) === 6（旧写法给 10）', contentWidth(8, 2) === 6, String(contentWidth(8, 2)));
}

// ============================================================
console.log('\n=== 8. 极窄终端不溢出 ===\n');
// ============================================================
{
  const TABLE3 = '| 姓名 | 年龄 | 城市 |\n|---|---|---|\n| 张三 | 28 | 北京 |\n| 李四 | 30 | 上海 |';
  const TABLE8 = '| a | b | c | d | e | f | g | h |\n|---|---|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |';

  for (const cols of [4, 5, 6, 7, 8, 10, 11, 12]) {
    for (const [name, item] of [
      ['用户消息', { kind: 'user', text: ZH }],
      ['md 段落', { kind: 'md', text: ZH }],
      ['思考块', { kind: 'thought', text: ZH, meta: { totalLines: 1, shownLines: 1, truncated: false } }],
      ['表格3列', { kind: 'md', text: TABLE3 }],
      ['表格8列', { kind: 'md', text: TABLE8 }],
    ]) {
      const lines = await renderItems([item], cols);
      const over = lines.filter(l => displayWidth(l) > cols);
      assert(`${cols}列 ${name} 不溢出`, over.length === 0,
        over.slice(0, 2).map(l => `[${displayWidth(l)}]${JSON.stringify(l.slice(0, 20))}`).join(' | '));
    }
  }

  // 极窄时表格放弃标签列（丢字段名优于溢出）
  const narrow = await renderItems([{ kind: 'md', text: TABLE3 }], 6);
  assert('6列 表格不再显示截断标签（值独占整行）',
    narrow.every(l => displayWidth(l) <= 6), narrow.map(l => displayWidth(l)).join(','));
  const wide = await renderItems([{ kind: 'md', text: TABLE3 }], 40);
  assert('40列 表格仍保留标签列（没有过度降级）',
    wide.some(l => /姓/.test(l)), wide.slice(0, 3).join(' | '));
}

// ============================================================
console.log('\n=== 9. 行内样式跨折行 ===\n');
// ============================================================
{
  const { parseInline, wrapSegments } = await import(D + 'cli/tui/render/inline.js');
  const widthOfSegs = (segs) => displayWidth(segs.map(s => s.text).join(''));

  const cases = [
    ['粗体跨行', '这是**加粗的跨越行边界的一段很长的文字**结束', 'bold'],
    ['行内代码跨行', '这是`inline code spanning the wrap boundary`结束', 'code'],
    ['斜体跨行', '这是*italic spanning the wrap boundary here*结束', 'italic'],
  ];

  for (const [name, text, styleKey] of cases) {
    const segs = parseInline(text);
    const lines = wrapSegments(segs, 14);

    // ① 字符完整：拼回去等于原文（去标记后的文本）
    const rebuilt = lines.map(l => l.map(s => s.text).join('')).join('');
    const plain = segs.map(s => s.text).join('');
    assert(`${name}：字符完整不丢`, rebuilt === plain,
      `${JSON.stringify(rebuilt.slice(0, 40))} ≠ ${JSON.stringify(plain.slice(0, 40))}`);

    // ② 每行宽度不超
    assert(`${name}：每行不超宽`, lines.every(l => widthOfSegs(l) <= 14),
      lines.map(l => widthOfSegs(l)).join(','));

    // ③ 样式延续：跨行时多行带该样式
    const styledLines = lines.filter(l => l.some(s => s[styleKey])).length;
    assert(`${name}：样式跨行延续（≥2 行带样式）`, styledLines >= 2, `${styledLines} 行`);
  }

  // 混合样式：三段各自延续
  const mixed = parseInline('中文**粗体bold**和`code here`以及*italic*混排测试跨行保持样式');
  const mLines = wrapSegments(mixed, 14);
  const rebuilt = mLines.map(l => l.map(s => s.text).join('')).join('');
  assert('混合样式：字符完整不丢', rebuilt === mixed.map(s => s.text).join(''));
  assert('混合样式：每行不超宽', mLines.every(l => widthOfSegs(l) <= 14),
    mLines.map(l => widthOfSegs(l)).join(','));
  assert('混合样式：bold/code/italic 都还在',
    mLines.some(l => l.some(s => s.bold))
    && mLines.some(l => l.some(s => s.code))
    && mLines.some(l => l.some(s => s.italic)));

  // 避头尾：标点不单独起行
  const punct = wrapSegments(parseInline('测试一下避头尾规则，标点不应该出现在行首。'), 10);
  assert('避头尾：行首不出现标点',
    punct.slice(1).every(l => {
      const first = l[0]?.text?.[0];
      return !first || !'。，、；：！？）」'.includes(first);
    }),
    punct.map(l => JSON.stringify(l.map(s => s.text).join(''))).join(' | '));
}

console.log(`\n结果: ${PASS} 通过, ${FAIL} 失败\n`);
process.exit(FAIL === 0 ? 0 : 1);
