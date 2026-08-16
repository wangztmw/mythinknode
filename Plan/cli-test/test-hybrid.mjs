// 混合模式回归测试 —— 主屏原生滚动条 + cell-diff 活区 + \n 提交溢出进原生 scrollback
// 用法: node Plan/cli-test/test-hybrid.mjs（需先 npm run build）
//
// 目标：验证混合模式（screen-state-hybrid.ts）：
//   1. 不进备用屏（不发 ?1049h / ?1000h / ?1006h / \x1b[J）
//   2. 溢出 → 原生 \n 滚动 + 只写新底行（不整屏重写）
//   3. 溢出回放正确（滚 + 写重建出正确网格）
//   4. in-place tick → cell-diff，无 \n
//   5. 溢出后紧跟 tick → delta 极小（prevViewport 同步正确）
//   6. 输入编辑 → cell-diff，无 \x1b[J
//   7. submitInput 提交进 content + 隐藏输入块
//   8. trim：20 行进 6 行，snapshot 恰好 6 行
//   9. 全流程往返：回放全部字节 == snapshot
import { HybridScreenState } from '../../dist/cli/render/screen-state-hybrid.js';
import { CellGrid } from '../../dist/cli/render/cell-grid.js';
import { charWidth } from '../../dist/cli/render/term-wrap.js';

const ROWS = 6, COLS = 20;

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

// 捕获 flush 的所有字节（覆盖 ss.emit）
function capture() {
  let out = '';
  const ss = new HybridScreenState('P> ', { rows: ROWS, cols: COLS });
  ss.emit = (raw) => { out += raw; };
  return { ss, get out() { return out; } };
}

// \n 感知网格模拟器：把 flush 的 ANSI 字节串应用到一个已有网格（还原屏幕状态）
function applyANSI(prev, ansi) {
  const grid = prev.clone();
  let row = 0, col = 0;
  for (let i = 0; i < ansi.length; i++) {
    const ch = ansi[i];
    if (ch === '\x1b') {
      const pos = /^\x1b\[(\d+);(\d+)H/.exec(ansi.slice(i));
      if (pos) { row = parseInt(pos[1]) - 1; col = parseInt(pos[2]) - 1; i += pos[0].length - 1; continue; }
      const other = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(ansi.slice(i));
      if (other) { i += other[0].length - 1; continue; }
      continue;
    }
    if (ch === '\n') { if (row >= grid.rows - 1) grid.scroll(1); else row++; continue; }
    if (ch === '\r') { col = 0; continue; }
    grid.set(row, col, ch, 0);
    const w = charWidth(ch);
    if (w === 2) grid.set(row, col + 1, '', 0);
    col += w;
  }
  return grid;
}

function gridToRows(grid) {
  const rows = [];
  for (let r = 0; r < grid.rows; r++) {
    let s = '';
    for (let c = 0; c < grid.cols; c++) { const cell = grid.get(r, c); if (cell.ch !== '') s += cell.ch; }
    rows.push(s.trimEnd());
  }
  return rows;
}

// 脚本化一轮对话（不含 tick 合并定时器，纯同步）
function runRound(ss, i) {
  ss.printPrompt();
  ss.submitInput(`hello ${i}`);
  ss.beginStatus(`  t${i}`, i > 1);
  ss.endStatus(`  done ${i}`);
  ss.writeLines(`result ${i}`);
}

console.log('\n=== 混合模式回归（主屏 + cell-diff 活区）===\n');

// 1. 不进备用屏
{
  const c = capture();
  c.ss.printPrompt();
  c.ss.submitInput('hi');
  c.ss.beginStatus('  thinking', false);
  c.ss.writeLines('result');
  assert('不进备用屏（无 ?1049h/?1000h/?1006h/\\x1b[J）',
    !c.out.includes('\x1b[?1049h') && !c.out.includes('\x1b[?1000h') && !c.out.includes('\x1b[?1006h') && !c.out.includes('\x1b[J'));
}

// 2. 溢出 → 原生 \n + 小 delta（不整屏重写）
{
  const c = capture();
  for (let i = 1; i <= 6; i++) c.ss.writeLines(String(i));
  const before = c.out.length;
  c.ss.writeLines('7');
  const delta = c.out.slice(before);
  const nl = (delta.match(/\n/g) || []).length;
  assert('溢出时 emit 原生 \\n（滚动）', nl >= 1);
  assert(`溢出不整屏重写（delta ${delta.length} 字节 < 40）`, delta.length < 40);
}

// 3. 溢出回放正确：滚 + 写重建出正确网格
{
  const c = capture();
  for (let i = 1; i <= 6; i++) c.ss.writeLines(String(i));
  const beforeGrid = applyANSI(new CellGrid(ROWS, COLS), c.out);
  const before = c.out.length;
  c.ss.writeLines('7');
  const afterGrid = applyANSI(beforeGrid, c.out.slice(before));
  const rows = gridToRows(afterGrid);
  assert('溢出回放：滚后网格为 2..7', rows[0] === '2' && rows[1] === '3' && rows[4] === '6' && rows[5] === '7');
}

// 4. in-place tick → cell-diff，无 \n
{
  const c = capture();
  c.ss.beginStatus('  t0', false);
  const before = c.out.length;
  c.ss.overwriteStatus('  t1');
  const delta = c.out.slice(before);
  assert('in-place tick：无 \\n 且 delta 小', !delta.includes('\n') && delta.length > 0 && delta.length < 20);
}

// 5. 溢出后紧跟 tick → delta 极小（prevViewport 同步正确）
{
  const c = capture();
  for (let i = 1; i <= 6; i++) c.ss.writeLines(String(i));
  c.ss.beginStatus('  t0', false);   // 触发溢出（6 行 content + status = 7 > 6）
  const before = c.out.length;
  c.ss.overwriteStatus('  t1');
  const delta = c.out.slice(before);
  assert('溢出后 tick 只写变化 cell（delta 极小、无 \\n）', delta.length > 0 && delta.length < 20 && !delta.includes('\n'));
}

// 6. 输入编辑 → cell-diff，无 \x1b[J
{
  const c = capture();
  c.ss.printPrompt();
  c.ss.rewriteInput('abc', 1, 0, 6);
  c.ss.rewriteInput('abXc', 1, 0, 7);
  assert('输入编辑：无 \\x1b[J 全屏清', !c.out.includes('\x1b[J'));
}

// 7. submitInput 提交进 content + 隐藏输入块
{
  const c = capture();
  c.ss.printPrompt();
  c.ss.submitInput('hi');
  const snap = c.ss.snapshot();
  assert('submitInput：输入行进 content', snap[0] === 'P> hi');
  assert('submitInput：输入块隐藏', snap[ROWS - 1] === '');
}

// 8. trim：20 行进 6 行，snapshot 恰好 6 行
{
  const c = capture();
  for (let i = 1; i <= 20; i++) c.ss.writeLines(String(i));
  const snap = c.ss.snapshot();
  assert('trim：snapshot 恰好 6 行', snap.length === ROWS);
  assert('trim：最后可见行是 20', snap[ROWS - 1] === '20');
}

// 9. 全流程往返：回放全部字节 == snapshot
{
  const c = capture();
  for (let i = 1; i <= 3; i++) runRound(c.ss, i);
  const rebuilt = applyANSI(new CellGrid(ROWS, COLS), c.out);
  const rebuiltRows = gridToRows(rebuilt);
  const snapRows = c.ss.snapshot();
  assert('全流程往返：ANSI 还原 == snapshot', JSON.stringify(rebuiltRows) === JSON.stringify(snapRows));
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
