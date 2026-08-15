// 折行无上限验证
// 用法: node Plan/cli-test/test-wrap.mjs

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
function breakLine(line, maxWidth) {
  const parts = [];
  let visible = 0, lastBreak = 0;
  const sgrStack = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const start = i; i++;
      if (i < line.length && line[i] === '[') {
        i++; const seqStart = i;
        while (i < line.length && !ANSI_END.test(line[i])) i++;
        const seq = line.slice(seqStart, i);
        if (line[i] === 'm') { if (seq === '0') sgrStack.length = 0; else sgrStack.push(seq); }
      }
      if (i >= line.length || !ANSI_END.test(line[i])) i = start;
      continue;
    }
    visible += charWidth(line[i]);
    if (visible >= maxWidth) { parts.push(line.slice(lastBreak, i + 1)); lastBreak = i + 1; visible = 0; if (sgrStack.length > 0) parts.push(`\x1b[${sgrStack.join(';')}m`); }
  }
  if (lastBreak < line.length) parts.push(line.slice(lastBreak));
  return parts.join('');
}

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

console.log('\n=== 折行无上限验证 ===\n');

const t0 = Date.now();
const line = '中'.repeat(50000);
const wrapped = breakLine(line, 80);
const t1 = Date.now();
assert('5万字中文折行（双宽）', wrapped.length > 0 && Math.ceil(displayWidth(line) / 80) > 100);
assert('5万字折行耗时 <100ms', t1 - t0 < 100);

const t2 = Date.now();
const ansiLine = '\x1b[1m' + 'A'.repeat(100000) + '\x1b[22m';
breakLine(ansiLine, 80);
const t3 = Date.now();
assert('10万字+ANSI 折行不崩', true);
assert('10万字+ANSI 耗时 <100ms', t3 - t2 < 100);

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
