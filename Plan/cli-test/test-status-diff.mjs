// AltScreenState（备用屏）网格渲染回归测试 —— 链接 screen-state-alt 的 grid 集成
// 用法: node Plan/cli-test/test-status-diff.mjs（需先 npm run build）
//
// 目标：验证 grid 渲染（状态行 diff + 输出 + 输入块）既降写频（字节下降），
// 又不破坏最终显示（网格终端模拟 + snapshot 往返一致）。
import { AltScreenState } from '../../dist/cli/render/screen-state-alt.js';
import { CellGrid } from '../../dist/cli/render/cell-grid.js';
import { charWidth } from '../../dist/cli/render/term-wrap.js';

const B = '\x1b[1m', b = '\x1b[22m';
const ROWS = 8, COLS = 24;

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

function display(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

// 网格终端模拟器：把 flush 的 ANSI 字节串应用到一个已有网格（还原屏幕状态）
function applyANSI(prev, ansi) {
  const grid = prev.clone();
  let row = 0, col = 0, style = 0;
  for (let i = 0; i < ansi.length; i++) {
    if (ansi[i] !== '\x1b') {
      const ch = ansi[i];
      grid.set(row, col, ch, style);
      const w = charWidth(ch);
      if (w === 2) grid.set(row, col + 1, '', style);
      col += w;
      continue;
    }
    const pos = /^\x1b\[(\d+);(\d+)H/.exec(ansi.slice(i));
    if (pos) { row = parseInt(pos[1]) - 1; col = parseInt(pos[2]) - 1; i += pos[0].length - 1; continue; }
    const sgr = /^\x1b\[(1|22|0)m/.exec(ansi.slice(i));
    if (sgr) { style = sgr[1] === '1' ? 1 : 0; i += sgr[0].length - 1; continue; }
  }
  return grid;
}

// 网格 → 行字符串（同 ScreenBuffer.snapshot 的显示语义）
function gridToRows(grid) {
  const rows = [];
  for (let r = 0; r < grid.rows; r++) {
    let s = '';
    for (let c = 0; c < grid.cols; c++) { const cell = grid.get(r, c); if (cell.ch !== '') s += cell.ch; }
    rows.push(s.trimEnd());
  }
  return rows;
}

function capture() {
  let out = '';
  const ss = new AltScreenState('P> ', { rows: ROWS, cols: COLS });
  ss.emit = (raw) => { out += raw; };
  return { ss, get out() { return out; } };
}

console.log('\n=== AltScreenState 网格渲染回归 ===\n');

// 1. prompt 贴底
{
  const c = capture();
  c.ss.printPrompt();
  const snap = c.ss.snapshot();
  assert('printPrompt：无内容时 prompt 在顶部', snap[0] === 'P>' && snap[ROWS - 1] === '');
}

// 2. 输入回显
{
  const c = capture();
  c.ss.printPrompt();
  c.ss.rewriteInput('hi', 1, 0, 5);
  assert('rewriteInput：prompt+输入', c.ss.snapshot()[0] === 'P> hi');
}

// 3. 提交隐藏输入块
{
  const c = capture();
  c.ss.printPrompt();
  c.ss.rewriteInput('hi', 1, 0, 5);
  c.ss.submitInput("hi");
  assert('submitInput：输入块隐藏', c.ss.snapshot()[ROWS - 1] === '');
}

// 4. 状态行在顶部 + 覆盖
{
  const c = capture();
  const c0 = `  ● ${B}Thinking${b} (0.0s)`;
  c.ss.beginStatus(c0, false);
  assert('beginStatus：状态行顶部', c.ss.snapshot()[0] === display(c0));
  const c1 = `  ● ${B}Thinking${b} (1.0s)`;
  c.ss.overwriteStatus(c1);
  assert('overwriteStatus：最终内容', c.ss.snapshot()[0] === display(c1));
}

// 5. 心跳 diff 字节下降（只写变化 cell，不整行重写）
{
  const c = capture();
  c.ss.beginStatus(`  ● ${B}Thinking${b} (0.0s)`, false);
  const before = c.out.length;
  c.ss.overwriteStatus(`  ● ${B}Thinking${b} (1.0s)`);
  const delta = c.out.length - before;
  assert('心跳 diff：只写变化 cell（字节 < 整行）', delta > 0 && delta < 20);
}

// 6. endStatus 定稿为输出行
{
  const c = capture();
  c.ss.beginStatus(`  ● ${B}Thinking${b} (0.0s)`, false);
  c.ss.endStatus(`  ● ${B}Thinking${b} (0.5s)`);
  assert('endStatus：定稿为输出行', c.ss.snapshot()[0] === '  ● Thinking (0.5s)');
}

// 7. writeLines 追加输出
{
  const c = capture();
  c.ss.endStatus(`  ● ${B}Thinking${b} (0.5s)`);
  c.ss.writeLines('hello\nworld');
  const snap = c.ss.snapshot();
  assert('writeLines：输出追加', snap[0] === '  ● Thinking (0.5s)' && snap[1] === 'hello' && snap[2] === 'world');
}

// 8. 全流程往返：flush 的 ANSI 还原 == snapshot
{
  const c = capture();
  c.ss.printPrompt();
  c.ss.rewriteInput('hi', 1, 0, 5);
  c.ss.submitInput("hi");
  c.ss.beginStatus(`  ● ${B}Thinking${b} (0.0s)`, false);
  c.ss.endStatus(`  ● ${B}Thinking${b} (0.5s)`);
  c.ss.writeLines('result text');
  const rebuilt = applyANSI(new CellGrid(ROWS, COLS), c.out);
  const rebuiltRows = gridToRows(rebuilt);
  const snapRows = c.ss.snapshot();
  assert('全流程往返：ANSI 还原 == snapshot', JSON.stringify(rebuiltRows) === JSON.stringify(snapRows));
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
