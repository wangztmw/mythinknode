// 用户真实 session 复现测试 —— 链接 term-wrap / input-geometry，验证「无超长行」不变式
// 用法: node Plan/cli-test/test-session.mjs（需先 npm run build）
//
// 目的：把用户触发崩溃的那几轮对话的输入+输出，跑一遍折行逻辑，
// 断言没有任何一行超过终端宽度（这是 Terminal.app 崩溃的根因）。
import { displayWidth, shouldWrap, wrapLine } from '../../dist/cli/render/term-wrap.js';
import { foldInput } from '../../dist/cli/input/input-geometry.js';

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

const COLS = 80, PW = 16;

console.log('\n=== 用户真实 session 无超长行复现 ===\n');

// —— 输入侧：用户 4 句 ——
{
  const inputs = [
    '你好',
    '你看看当前有哪些书籍',
    '你能读一本书的内容吗',
    '我之前是想测试我的智能体的能力，主要是有关于cli的部分，因为之前一直有各种奇怪的',
  ];
  for (const s of inputs) {
    const folded = foldInput(Array.from(s), COLS, PW);
    const lines = folded.split('\n');
    const ok = lines.every((l, i) => displayWidth(l) <= (i === 0 ? COLS - PW : COLS));
    assert(`输入「${s.slice(0, 12)}…」折行后无超长行`, ok);
  }
}

// —— 输出侧：book list / table / code block / quote / emoji ——
{
  const outputs = [
    '  书名                 作者                 大小',
    '  一小时漫画缠论实战法 管鹏                 12.8 MB',
    '📊 财报 & 会计',
    '1. 一本书读懂财报 (肖星) — EPUB',
    '  ● Bash (0.0s): ls -la /Users/Zhuanz1/Desktop/金融  → total 788768...',
    '  ● Bash (0.1s): python3 - <<\'EOF\'',
    'import re, glob, html, os',
    'd = "/tmp/ebook_1786790981"',
    '│ 会计是什么？问得好。有的人干了一辈子的会计都不知道会计是什么……会计既不是科学，也不是艺术……',
  ];
  for (const line of outputs) {
    const rows = wrapLine(line, COLS);
    const ok = rows.every(r => displayWidth(r) <= COLS);
    assert(`输出「${line.slice(0, 16)}…」折行后无超长行`, ok);
  }
}

// —— 输出侧：renderMergedTools 的真实样本（含 ANSI 粗体 + 多行 sample）——
{
  const B = '\x1b[1m', b = '\x1b[22m';
  const toolLine = `  ● ${B}Bash${b} (0.1s): python3 - <<'EOF'\nimport re, glob, html, os\n\nd = open("/tmp/ebook_1786790981/index_split_002.html").read()`;
  const lines = toolLine.split('\n');
  let ok = true;
  for (const l of lines) for (const r of wrapLine(l, COLS)) if (displayWidth(r) > COLS) ok = false;
  assert('工具 sample（多行 + ANSI）折行后无超长行', ok);
}

// —— 极端：超长单行（500 字符）也绝不超宽 ——
{
  const long = '字'.repeat(250);  // 500 显示宽
  const rows = wrapLine(long, COLS);
  assert('250 个双宽字折行后每行 ≤ 80', rows.every(r => displayWidth(r) <= COLS));
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
