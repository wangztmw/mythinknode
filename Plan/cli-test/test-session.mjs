// 用户真实 session 复现测试 —— 用「几乎没改过的原句」验证「无超长行」不变式
// 用法: node Plan/cli-test/test-session.mjs
//
// 目的：把用户触发崩溃的那几轮对话的输入+输出，跑一遍折行逻辑，
// 断言没有任何一行超过终端宽度（这是 Terminal.app 崩溃的根因）。

const ANSI_END = /^[A-Za-z]$/;
function charWidth(c) {
  const code = c.codePointAt(0);
  if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) || (code >= 0xF900 && code <= 0xFAFF)) return 2;
  if ((code >= 0x3000 && code <= 0x303F) || (code >= 0xFF01 && code <= 0xFF60) || (code >= 0xFFE0 && code <= 0xFFE6)) return 2;
  if (code >= 0xAC00 && code <= 0xD7AF) return 2;
  if (code < 0x20 || (code >= 0x7F && code <= 0x9F)) return 0;
  return 1;
}
function displayWidth(s) {
  const clean = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let w = 0; for (const c of clean) w += charWidth(c);
  return w;
}
function shouldWrap(col, w, cols) { return col + w > cols; }
// 复刻 wrapLine（输出折行）
function wrapLine(line, cols) {
  if (displayWidth(line) <= cols) return [line];
  const rows = []; let cur = '', curW = 0; const sgr = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const start = i; i++;
      if (i < line.length && line[i] === '[') {
        i++; const seqStart = i;
        while (i < line.length && !ANSI_END.test(line[i])) i++;
        const seq = line.slice(seqStart, i);
        if (line[i] === 'm') { if (seq === '0') sgr.length = 0; else sgr.push(seq); }
      }
      cur += line.slice(start, i + 1); continue;
    }
    const w = charWidth(line[i]);
    if (curW + w > cols && curW > 0) { rows.push(cur); cur = sgr.length ? `\x1b[${sgr.join(';')}m` : ''; curW = 0; }
    cur += line[i]; curW += w;
  }
  rows.push(cur); return rows;
}
// 复刻 foldInput（输入折行，首行有 promptW 偏移）
function foldInput(chars, cols, promptW) {
  let col = promptW, out = '';
  for (const c of chars) {
    if (c === '\n') { out += '\n'; col = 0; continue; }
    const w = charWidth(c);
    if (shouldWrap(col, w, cols)) { out += '\n' + c; col = w; }
    else { out += c; col += w; }
  }
  return out;
}

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
