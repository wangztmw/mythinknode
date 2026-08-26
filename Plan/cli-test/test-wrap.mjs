// 折行无上限验证 —— 链接 term-wrap 的 wrapLine
// 用法: node Plan/cli-test/test-wrap.mjs（需先 npm run build）
import { wrapLine } from '../../dist/cli/render/term-wrap.js';

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

console.log('\n=== 折行无上限验证 ===\n');

const t0 = Date.now();
const line = '中'.repeat(50000);
const wrapped = wrapLine(line, 80);
const t1 = Date.now();
assert('5万字中文折行（双宽）', wrapped.length > 100);
assert('5万字折行耗时 <100ms', t1 - t0 < 100);

const t2 = Date.now();
const ansiLine = '\x1b[1m' + 'A'.repeat(100000) + '\x1b[22m';
wrapLine(ansiLine, 80);
const t3 = Date.now();
assert('10万字+ANSI 折行不崩', true);
assert('10万字+ANSI 耗时 <100ms', t3 - t2 < 100);

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
