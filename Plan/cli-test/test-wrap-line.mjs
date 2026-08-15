// wrapLine（主动折行）回归测试 —— 链接 src/cli/render/term-wrap.ts 的 wrapLine
// 用法: node Plan/cli-test/test-wrap-line.mjs（需先 npm run build）
import { wrapLine, displayWidth } from '../../dist/cli/render/term-wrap.js';

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
