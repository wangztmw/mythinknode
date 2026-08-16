// 状态行 diff 回归测试 —— 链接 screen-state 的 beginStatus/overwriteStatus（主屏原生版）
// 用法: node Plan/cli-test/test-status-diff.mjs（需先 npm run build）
//
// 目标：验证心跳「前缀 diff」既降写频（字节数下降），又不破坏最终显示（单行终端模拟）。
import { ScreenState } from '../../dist/cli/render/screen-state.js';

const B = '\x1b[1m', b = '\x1b[22m';

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

function capture() {
  let out = '';
  const ss = new ScreenState('P> ');
  ss.emit = (raw) => { out += raw; };
  return { ss, get out() { return out; } };
}

// 单行终端模拟器：解释 \r / \x1b[nC / \x1b[K / 字符写（ANSI m 忽略）
function simulateLine(raw) {
  let line = '', col = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\r') { col = 0; continue; }
    if (ch === '\x1b') {
      const m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(raw.slice(i));
      if (m) {
        const params = m[1].split(';').map(Number);
        const cmd = m[2];
        if (cmd === 'C') col += params[0] || 1;
        else if (cmd === 'K') line = line.slice(0, col);
        i += m[0].length - 1;
      }
      continue;
    }
    line = line.slice(0, col) + ch + line.slice(col + 1);
    col += 1;
  }
  return line;
}

function display(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

console.log('\n=== 状态行 diff 回归 ===\n');

// 1. begin + 一次 overwrite（秒数 0.0s→1.0s）：最终显示正确 + 字节下降
{
  const c = capture();
  const c0 = `  ● ${B}Thinking${b} (0.0s) — analyzing`;
  const c1 = `  ● ${B}Thinking${b} (1.0s) — analyzing`;
  c.ss.beginStatus(c0, false);
  c.ss.overwriteStatus(c1);
  const fullRewrite = `\r${c0}\x1b[K\r${c1}\x1b[K`;
  assert('秒数变化：最终显示正确', simulateLine(c.out) === display(c1));
  assert('秒数变化：diff 字节 < 两次整行写', c.out.length < fullRewrite.length);
  assert('秒数变化：不重复写前缀「  ● 」', c.out.indexOf('  ● ') === c.out.lastIndexOf('  ● '));
}

// 2. 连续多次 overwrite（1.0s→2.0s→3.0s）：最终显示正确
{
  const c = capture();
  c.ss.beginStatus(`  ● ${B}Thinking${b} (1.0s) — analyzing`, false);
  const target = `  ● ${B}Thinking${b} (3.0s) — analyzing`;
  c.ss.overwriteStatus(`  ● ${B}Thinking${b} (2.0s) — analyzing`);
  c.ss.overwriteStatus(target);
  assert('连续心跳：最终显示正确', simulateLine(c.out) === display(target));
}

// 3. 名字变化（Thinking→Bash，diff 点落在粗体段内）：回退整行写，最终显示正确
{
  const c = capture();
  c.ss.beginStatus(`  ● ${B}Thinking${b} (0.0s) — analyzing`, false);
  const target = `  ● ${B}Bash${b} (0.0s)`;
  c.ss.overwriteStatus(target);
  assert('名字变化：最终显示正确（回退整行写）', simulateLine(c.out) === display(target));
}

// 4. endStatus 定稿（\r 覆盖 + \n 收尾）
{
  const c = capture();
  c.ss.beginStatus(`  ● ${B}Thinking${b} (0.0s)`, false);
  c.ss.endStatus(`  ● ${B}Thinking${b} (0.5s)`);
  assert('endStatus：\r 覆盖 + \n 收尾', c.out.endsWith('\n') && c.out.includes('\r'));
}

// 5. writeLines 节流：多行同步不写（异步摊开滚动爆发）
{
  let sync = 0;
  const ss = new ScreenState('P> ');
  ss.emit = () => { sync++; };
  ss.writeLines('line1\nline2\nline3\nline4\nline5');
  assert('writeLines 5 行：同步不写（节流摊开）', sync === 0);
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
