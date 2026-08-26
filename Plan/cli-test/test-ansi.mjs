// 复现：从终端复制的文本含 ANSI 码，混入输入导致 LLM JSON 崩溃 —— 链接 cleanInput
// 用法: node Plan/cli-test/test-ansi.mjs（需先 npm run build）
import { cleanInput } from '../../dist/cli/input/input-geometry.js';

const dirtyInput = '第一段\x1b[36mmythinknode\x1b[39m\x1b[1m>>>\x1b[22m 报错内容\r\n\x1b[2m(59 lines total)\x1b[22m';
const cleaned = cleanInput(dirtyInput);

console.log('=== 清洗前（含 ANSI 码）===');
console.log(JSON.stringify(dirtyInput));
console.log('=== 清洗后 ===');
console.log(JSON.stringify(cleaned));

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

assert('清洗后无残留 \x1b', !cleaned.includes('\x1b'));
assert('清洗后无残留 \r', !cleaned.includes('\r'));
assert('保留正文内容', cleaned === '第一段mythinknode>>> 报错内容\n(59 lines total)');

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
