// wrapLine（主动折行）回归测试 —— 复刻 src/cli/render/term-wrap.ts 的 wrapLine
// 用法: node Plan/cli-test/test-wrap-line.mjs
//
// 备用屏全屏重绘的必需件：历史/输出行必须先折成「每行显示宽 ≤ cols」的可视行，
// 否则超长行被终端软折行，会破坏「1 逻辑行 = 1 屏幕行」的布局假设。

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
// 与 term-wrap.ts 的 wrapLine 一致
function wrapLine(line, cols) {
  if (displayWidth(line) <= cols) return [line];
  const rows = [];
  let cur = '', curW = 0;
  const sgr = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const start = i; i++;
      if (i < line.length && line[i] === '[') {
        i++; const seqStart = i;
        while (i < line.length && !ANSI_END.test(line[i])) i++;
        const seq = line.slice(seqStart, i);
        if (line[i] === 'm') { if (seq === '0') sgr.length = 0; else sgr.push(seq); }
      }
      cur += line.slice(start, i + 1);
      continue;
    }
    const w = charWidth(line[i]);
    if (curW + w > cols && curW > 0) {
      rows.push(cur);
      cur = sgr.length ? `\x1b[${sgr.join(';')}m` : '';
      curW = 0;
    }
    cur += line[i];
    curW += w;
  }
  rows.push(cur);
  return rows;
}

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

console.log('\n=== wrapLine 主动折行回归 ===\n');

// 1. 短行不折
{
  const r = wrapLine('hello', 80);
  assert('短行原样返回（单行）', r.length === 1 && r[0] === 'hello');
}

// 2. 长 ASCII 折行，每行宽 ≤ cols，且不丢字
{
  const line = 'a'.repeat(200);
  const r = wrapLine(line, 80);
  assert('200 窄字符折成 3 行（80/80/40）', r.length === 3);
  assert('每行显示宽 ≤ 80', r.every(x => displayWidth(x) <= 80));
  assert('总字符数不变（200）', r.reduce((n, x) => n + x.replace(/\x1b\[[0-9;]*m/g, '').length, 0) === 200);
}

// 3. 延迟折行边界：80 个窄字符 = 恰好 1 行（不提前折）
{
  const r = wrapLine('a'.repeat(80), 80);
  assert('80 窄字符恰好 1 行', r.length === 1);
}

// 4. 81 个窄字符 = 2 行（第 81 个才折）
{
  const r = wrapLine('a'.repeat(81), 80);
  assert('81 窄字符 = 2 行', r.length === 2 && r[1].length === 1);
}

// 5. 中文双宽折行：不把双宽字劈成两半
{
  const line = '中'.repeat(50); // 50 × 2 = 100 宽
  const r = wrapLine(line, 80);
  assert('50 个双宽字折成 2 行（40/10 字）', r.length === 2);
  assert('第 1 行 40 个「中」（80 宽）', r[0].length === 40);
  assert('第 2 行 10 个「中」（20 宽）', r[1].length === 10);
}

// 6. ANSI SGR 跨行保留：长行带粗体，折行后第二行开头重新注入粗体
{
  const line = '\x1b[1m' + 'a'.repeat(100) + '\x1b[22m';
  const r = wrapLine(line, 80);
  assert('带 ANSI 长行折成 2 行', r.length === 2);
  assert('第 2 行重新注入粗体 SGR', r[1].startsWith('\x1b[1m'));
}

// 7. 每个可视行宽（去 ANSI）≤ cols
{
  const line = '汉'.repeat(100) + 'abc'; // 100×2 + 3 = 203 宽
  const r = wrapLine(line, 80);
  assert('混合长行每行宽 ≤ 80', r.every(x => displayWidth(x) <= 80));
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
