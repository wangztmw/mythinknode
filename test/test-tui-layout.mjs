// TUI 布局纯函数回归测试
// 用法: node Plan/cli-test/test-tui-layout.mjs（需先 npm run build）
import {
  getBreakpoint,
  dashboardBreakpoints,
} from '../dist/cli/tui/layout/breakpoints.js';
import { computeInputGeometry } from '../dist/cli/tui/layout/geometry.js';
import { inputLines, clamp } from '../dist/cli/tui/layout/limits.js';
import { displayWidth, truncateToWidth, truncateGraphemes } from '../dist/cli/tui/text/width.js';
import { wrapLines, cursorLineColumn } from '../dist/cli/tui/text/wrap.js';
import { sanitizeOutput } from '../dist/cli/tui/text/sanitize.js';
import { buildPreview } from '../dist/cli/tui/text/preview.js';

let PASS = 0, FAIL = 0;
function assert(name, cond) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}`); }
}

console.log('\n=== TUI 布局纯函数回归 ===\n');

// ---- 断点 ----
{
  assert('49 列 = narrow', getBreakpoint(49, 24).name === 'narrow');
  assert('50 列 = compact', getBreakpoint(50, 24).name === 'compact');
  assert('79 列 = compact', getBreakpoint(79, 24).name === 'compact');
  assert('80 列 = normal', getBreakpoint(80, 24).name === 'normal');
  assert('119 列 = normal', getBreakpoint(119, 24).name === 'normal');
  assert('120 列 = wide', getBreakpoint(120, 24).name === 'wide');
  assert('看板双栏阈值保持 84', !dashboardBreakpoints.twoColumn(83) && dashboardBreakpoints.twoColumn(84));
  assert('看板 logo 条件保持 72/30',
    !dashboardBreakpoints.logo(71, 30) && !dashboardBreakpoints.logo(72, 29) && dashboardBreakpoints.logo(72, 30));
}

// ---- 输入几何 ----
{
  const normal = computeInputGeometry(80, getBreakpoint(80, 24));
  assert('80 列：paddingX=1, textWidth=74, inputX=4',
    normal.paddingX === 1 && normal.textWidth === 74 && normal.inputX === 4);

  const narrow = computeInputGeometry(40, getBreakpoint(40, 24));
  assert('40 列：paddingX=0, textWidth=36, inputX=3',
    narrow.paddingX === 0 && narrow.textWidth === 36 && narrow.inputX === 3);

  const wide = computeInputGeometry(120, getBreakpoint(120, 40));
  assert('120 列：textWidth=114, inputX=4',
    wide.paddingX === 1 && wide.textWidth === 114 && wide.inputX === 4);
}

// ---- 输入行数 ----
{
  assert('rows=24 → 12 行', inputLines(24) === 12);
  assert('rows=18 → 6 行', inputLines(18) === 6);
  assert('rows=17 → 4 行', inputLines(17) === 4);
  assert('rows=10 → 4 行', inputLines(10) === 4);
  assert('clamp(5,4,12)=5', clamp(5, 4, 12) === 5);
  assert('clamp(1,4,12)=4', clamp(1, 4, 12) === 4);
  assert('clamp(99,4,12)=12', clamp(99, 4, 12) === 12);
}

// ---- 宽度 / 截断 ----
{
  assert('中文宽 2', displayWidth('中') === 2);
  assert('ASCII 宽 1', displayWidth('abc') === 3);
  assert('emoji 家庭宽 2（string-width）', displayWidth('👨‍👩‍👧‍👦') === 2);

  const truncated = truncateToWidth('中文abc', 5);
  assert('按显示宽度截断为 5 列', displayWidth(truncated) <= 5 && truncated.endsWith('…'));
  assert('不切断中文', truncated === '中文…');

  assert('grapheme 截断不切代理对', truncateGraphemes('👨‍👩‍👧‍👦abc', 1) === '👨‍👩‍👧‍👦');
}

// ---- 折行 / 光标 ----
{
  const lines = wrapLines('中'.repeat(10), 8);
  assert('10 个中文按 8 列折成 3 行', lines.length === 3);
  assert('每行显示宽 ≤ 8', lines.every(line => displayWidth(line) <= 8));
  assert('总字符数不变', lines.join('').length === 10);

  const pos = cursorLineColumn('ab中', 3, 4);
  assert('光标落在第 0 行第 4 列', pos.line === 0 && pos.col === 4);
}

// ---- 清洗 ----
{
  const dirty = '\x1b[31mred\x1b[0m\r\nline2\rline3\x1b]0;title\x07\x07\x01\tend';
  const clean = sanitizeOutput(dirty);
  assert('移除 CSI', !clean.includes('\x1b['));
  assert('移除 OSC', !clean.includes('title'));
  assert('\\r 转换行', clean.includes('red\n') && clean.includes('line2\nline3'));
  assert('保留 tab', clean.includes('\t'));
  assert('移除其他控制字符', !clean.includes('\x01') && !clean.includes('\x07'));
}

// ---- 语义预览 ----
{
  const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
  const preview = buildPreview(text, 8, 800);
  assert('最多 8 逻辑行', preview.shownLines === 8);
  assert('总行数 10', preview.totalLines === 10);
  assert('标记为截断', preview.truncated === true);

  const oneLong = '一'.repeat(2000);
  const capped = buildPreview(oneLong, 8, 100);
  assert('单行超字符上限时截断', capped.shownLines === 1 && capped.text.length <= 100);
  assert('超字符上限标记截断', capped.truncated === true);

  const short = buildPreview('a\nb', 8, 800);
  assert('短文本不标记截断', short.truncated === false && short.shownLines === 2);
}

console.log(`\n结果: ${PASS} 通过, ${FAIL} 失败\n`);
if (FAIL > 0) process.exit(1);
