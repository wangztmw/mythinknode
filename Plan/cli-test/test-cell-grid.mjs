// CellGrid + Diff + Emitter 回归测试（方向 B 第一步的纯逻辑）
// 用法: node Plan/cli-test/test-cell-grid.mjs（需先 npm run build）
import { CellGrid, STYLE_BOLD } from '../../dist/cli/render/cell-grid.js';
import { diff } from '../../dist/cli/render/diff.js';
import { patchesToANSI } from '../../dist/cli/render/emitter.js';
import { charWidth } from '../../dist/cli/render/term-wrap.js';

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

function gridEquals(a, b) {
  if (a.rows !== b.rows || a.cols !== b.cols) return false;
  for (let r = 0; r < a.rows; r++)
    for (let c = 0; c < a.cols; c++) {
      const x = a.get(r, c), y = b.get(r, c);
      if (x.ch !== y.ch || x.style !== y.style) return false;
    }
  return true;
}

// 模拟终端：把 ANSI 字节串（diff 结果）应用到一个已有网格，还原屏幕状态
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
    const sgr = /^\x1b\[(1|22)m/.exec(ansi.slice(i));
    if (sgr) { style = sgr[1] === '1' ? STYLE_BOLD : 0; i += sgr[0].length - 1; continue; }
  }
  return grid;
}

console.log('\n=== CellGrid + Diff + Emitter 回归 ===\n');

// 1. write 推进列 + CJK 双宽占 2 格
{
  const g = new CellGrid(3, 10);
  const nextCol = g.write(0, 0, 'a中b', 0);
  assert('write 返回下一个列号（a=1 + 中=2 + b=1）', nextCol === 4);
  assert('中 落在第 1 格', g.get(0, 1).ch === '中');
  assert('中 的后半格为空占位', g.get(0, 2).ch === '' && g.get(0, 2).style === 0);
  assert('b 落在第 3 格', g.get(0, 3).ch === 'b');
}

// 2. scroll 上移 + 底部补空
{
  const g = new CellGrid(3, 5);
  g.write(0, 0, 'AAA', 0);
  g.write(1, 0, 'BBB', 0);
  g.write(2, 0, 'CCC', 0);
  g.scroll(1);
  assert('scroll 后顶部是原第 2 行', g.get(0, 0).ch === 'B');
  assert('scroll 后底部补空', g.get(2, 0).ch === ' ');
}

// 3. diff + emitter 往返：改一格/改一行 → 写出的 ANSI 还原后 == 新网格
{
  const a = new CellGrid(3, 10);
  a.write(0, 0, 'hello', 0);
  a.write(1, 0, 'world', STYLE_BOLD);

  const b = a.clone();
  b.write(1, 0, 'WORLD', STYLE_BOLD);  // 改第 2 行（含 bold）

  const ansi = patchesToANSI(diff(a, b));
  const rebuilt = applyANSI(a, ansi);
  assert('diff+emitter 往返还原 == 新网格', gridEquals(rebuilt, b));
}

// 4. diff 只写变化部分：改一个字符只产出一个 patch、字节数远小于整屏
{
  const a = new CellGrid(3, 10);
  a.write(0, 0, 'hello', 0);
  const b = a.clone();
  b.write(0, 4, 'X', 0);  // 只改 'o' → 'X'
  const patches = diff(a, b);
  const ansi = patchesToANSI(patches);
  assert('只改 1 字符：产出 1 个 patch', patches.length === 1);
  assert('只改 1 字符：字节数 < 整屏重写', ansi.length < 10);
  const rebuilt = applyANSI(a, ansi);
  assert('只改 1 字符：还原正确', gridEquals(rebuilt, b));
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
