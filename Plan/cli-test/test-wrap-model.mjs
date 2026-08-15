// 延迟折行（DEC autowrap）模型回归测试 —— 复刻 cli.ts 的 cursorPos/contentLines 折行逻辑
// 用法: node Plan/cli-test/test-wrap-model.mjs
//
// 目标：锁死「折行边界必须用 >（延迟折行），不能用 >=（立即折行）」这一结论，
// 防止以后再次把 > 改回 >= 导致输入/输出光标认知错位（几轮后空位/少字/终端崩溃）。

function charWidth(c) {
  const code = c.codePointAt(0);
  if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) || (code >= 0xF900 && code <= 0xFAFF)) return 2;
  if ((code >= 0x3000 && code <= 0x303F) || (code >= 0xFF01 && code <= 0xFF60) || (code >= 0xFFE0 && code <= 0xFFE6)) return 2;
  if (code >= 0xAC00 && code <= 0xD7AF) return 2;
  if (code < 0x20 || (code >= 0x7F && code <= 0x9F)) return 0;
  return 1;
}

// 与 src/cli/render/term-wrap.ts 的 shouldWrap 完全一致
function shouldWrap(col, w, cols) { return col + w > cols; }

// 复刻 cli.ts 的 contentLines（延迟折行）
function contentLines(chars, cols, promptW) {
  let lines = 1, col = promptW;
  for (const c of chars) {
    if (c === '\n') { lines++; col = 0; continue; }
    const w = charWidth(c);
    if (shouldWrap(col, w, cols)) { lines++; col = w; }
    else { col += w; }
  }
  return lines;
}

// 复刻 cli.ts 的 cursorPos（延迟折行）
function cursorPos(chars, cursor, cols, promptW) {
  let line = 0, col = promptW;
  for (let i = 0; i < cursor; i++) {
    const c = chars[i];
    if (c === '\n') { line++; col = 0; continue; }
    const w = charWidth(c);
    if (shouldWrap(col, w, cols)) { line++; col = w; }
    else { col += w; }
  }
  return { line, col };
}

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

console.log('\n=== 延迟折行（autowrap）模型回归 ===\n');

const COLS = 80, PW = 16; // prompt "mythinknode >>> " 宽 16，内容区 16..79 共 64 列

// 1. 正好写满最后一列（64 个窄字符）→ 仍 1 行，不提前折
{
  const chars = Array.from('a'.repeat(64));
  assert('64 窄字符正好写满最后列 → 1 行（不提前折）', contentLines(chars, COLS, PW) === 1);
  const p = cursorPos(chars, 64, COLS, PW);
  assert('64 窄字符光标 col=80（pending-wrap）', p.line === 0 && p.col === 80);
}

// 2. 第 65 个窄字符才折行
{
  const chars = Array.from('a'.repeat(65));
  assert('65 窄字符 → 2 行（下一个字符才折）', contentLines(chars, COLS, PW) === 2);
  const p = cursorPos(chars, 65, COLS, PW);
  assert('65 窄字符光标在第 1 行 col=1', p.line === 1 && p.col === 1);
}

// 3. 宽字符塞不进最后一列（col=79 只剩 1 列）→ 提前折
{
  const chars = Array.from('a'.repeat(63)).concat(['中']); // 63 窄 + 1 宽
  // 63 窄 → col=79；下一宽字符 w=2，79+2>80 → 折行
  assert('宽字符在最后列 → 提前折到下一行', contentLines(chars, COLS, PW) === 2);
}

// 4. 宽字符恰好写满 cols-2..cols-1（col=78 + w=2 = 80）→ 不折，进入 pending-wrap
{
  const chars = Array.from('a'.repeat(62)).concat(['中']); // 62 窄 → col=78；宽字符 78+2=80 不折
  assert('宽字符恰好写满右缘 → 仍 1 行', contentLines(chars, COLS, PW) === 1);
  const p = cursorPos(chars, 63, COLS, PW);
  assert('宽字符写满右缘后 col=80（pending-wrap）', p.line === 0 && p.col === 80);
}

// 5. 显式 \n 重置列，后续重新计
{
  const chars = Array.from('a'.repeat(100)).concat(['\n', 'b']);
  assert('显式换行后重置，行数正确', contentLines(chars, COLS, PW) === 3); // 100 窄 = 2 行 + \n + 1 行
}

// 6. 回归点：>= 会误判（这里用立即折行版对照，证明二者不等价）
{
  function contentLinesImmediate(chars, cols, promptW) {
    let lines = 1, col = promptW;
    for (const c of chars) {
      if (c === '\n') { lines++; col = 0; continue; }
      const w = charWidth(c);
      if (col + w >= cols) { lines++; col = w; }  // 立即折行（错误模型）
      else { col += w; }
    }
    return lines;
  }
  const chars = Array.from('a'.repeat(64));
  assert('对照：立即折行(>=) 会误判 64 窄字符为 2 行', contentLinesImmediate(chars, COLS, PW) === 2);
}

// 复刻 cli.ts 的 foldInput（主动折行输入，保证无超长行——输入侧防崩溃的关键）
function foldInput(chars, cols, promptW) {
  let col = promptW, out = '';
  for (const c of chars) {
    if (c === '\n') { out += '\n'; col = 0; continue; }
    const w = charWidth(c);
    if (shouldWrap(col, w, cols)) { out += '\n' + c; col = w; }
    else { out += c; col += w; }
  }
  return out;
}
function dWidth(s) { let w = 0; for (const c of s) w += charWidth(c); return w; }

// 7. 输入折行：长 CJK 输入折成多行，每行宽 ≤ cols（无超长行）
{
  const cols = 80, promptW = 16;
  const chars = Array.from('中'.repeat(60));  // 60 × 2 = 120 宽
  const folded = foldInput(chars, cols, promptW);
  const lines = folded.split('\n');
  const firstMax = cols - promptW;  // 第一行内容宽 ≤ cols - promptW
  assert('长输入折成多行', lines.length >= 2);
  assert('输入每行宽 ≤ cols（无超长行）', lines.every((l, i) => dWidth(l) <= (i === 0 ? firstMax : cols)));
}

// 8. 输入折行后，contentLines 与 foldInput 行数一致（光标定位依赖这个一致性）
{
  const cols = 80, promptW = 16;
  const chars = Array.from('a'.repeat(64)).concat(['中']);  // 64 窄 + 1 双宽 = 66 宽
  const lines = foldInput(chars, cols, promptW).split('\n').length;
  assert('foldInput 行数 == contentLines 行数', lines === contentLines(chars, cols, promptW));
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
