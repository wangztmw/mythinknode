// 光标位置回归测试 —— 「发完消息再打字，光标不在输入框里」
//
// 用法: npm run build && node Plan/cli-test/test-tui-cursor.mjs
//
// ## 为什么需要这个测试
//
// `InputBox` 用 `useCursor().setCursorPosition()` 手动定位光标，而 `y` 是相对
// **动态区域**（ink 每帧重绘的部分，不含 `<Static>`）顶行算起的行号。
//
// 原先 `geometry.inputY` 硬编码为 2（只算 InputBox 自己的 marginTop + 上边框），
// 漏掉了 busy 时出现在上方的 ThinkingStatus（2 行）。于是：
//
//   idle  输入框内容在帧内第 2 行 → 光标 y=2  ✅
//   busy  输入框内容在帧内第 4 行 → 光标 y=2  ❌ 偏上 2 行
//
// 改前发现不了，因为 busy 时 `{state.waiting && <InputBox/>}` 根本不渲染输入框，
// 那个错误值从未被使用；输入框常驻后才暴露。
//
// ## 测试方法
//
// cursorSuffix 是**相对移动**序列（`\x1b[{n}A` + `\x1b[{x}G`），没法直接读出
// 绝对行号。所以这里实现一个最小 VT 模拟器，吃一遍 stdout 字节流，得到
// 最终的屏幕行 + 光标坐标，再断言「光标所在行 == 输入框内容所在行」。
//
// 这样才能真正抓住这个 bug —— 断言几何函数本身只能证明「参数生效了」，
// 证明不了「参数传的是对的」。
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../src');
const D = new URL('../dist/', import.meta.url).pathname;

const React = (await import('react')).default;
const { render } = await import('ink');
const { TuiStore } = await import(D + 'cli/tui/store.js');
const { SessionApp } = await import(D + 'cli/tui/SessionApp.js');
const { WindowSizeProvider } = await import(D + 'cli/tui/layout/window-size.js');
const { computeInputGeometry, INPUT_OWN_ABOVE, ABOVE_BLOCK_HEIGHTS } =
  await import(D + 'cli/tui/layout/geometry.js');

// ============================================================
// 只解析「最后一帧」，不做终端状态模拟
// ============================================================
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07]*\x07/g;
const strip = (s) => s.replace(OSC, '').replace(ANSI, '');

/**
 * 从 stdout 字节流里取出最后一帧，返回 { lines, cursorY, cursorX }。
 *
 * ink 的渲染格式（synchronized update 包裹）：
 *   \x1b[?2026h                       同步输出开始
 *   [\x1b[?25l]                       隐藏光标（非首帧时）
 *   (\x1b[G\x1b[2K\x1b[1A)* \x1b[G\x1b[2K   eraseLines(prev)：清掉上一帧
 *   <text>                            本帧全部内容
 *   [\x1b[{n}A] \x1b[{x}G \x1b[?25h    cursorSuffix：从帧底上移 n 行、到第 x 列
 *   \x1b[?2026l                       同步输出结束
 *
 * cursorPosition.y 的坐标系就是 `<text>` 的行号 → y = bottomLine - moveUp。
 *
 * ⚠️ 不要试图从 buf 开头模拟整个终端：多帧重绘是**覆盖**而非追加，
 * 朴素累积会让行号不断偏移（第一版就这么错了）。只取最后一帧最稳。
 */
function lastFrame(buf) {
  const start = buf.lastIndexOf('\x1b[?2026h');
  let s = start >= 0 ? buf.slice(start) : buf;
  s = s.replace(/^\x1b\[\?2026h/, '');
  s = s.replace(/^(\x1b\[G\x1b\[2K\x1b\[1A)+/, '');   // eraseLines 的重复段
  s = s.replace(/^\x1b\[G\x1b\[2K/, '');              // eraseLines 的收尾段
  s = s.replace(/^\x1b\[\?25l/, '');                  // hideCursor 前缀

  const m = /(?:\x1b\[(\d+)A)?\x1b\[(\d+)G\x1b\[\?25h/.exec(s);
  if (!m) return null;

  const moveUp = m[1] ? parseInt(m[1], 10) : 0;
  const cursorX = parseInt(m[2], 10) - 1;
  const lines = strip(s.slice(0, m.index)).split('\n');
  return { lines, cursorY: lines.length - 1 - moveUp, cursorX };
}


class FakeStdout extends EventEmitter {
  constructor(columns) { super(); this.columns = columns; this.rows = 40; this.isTTY = true; this.buf = ''; }
  write(s) { this.buf += s; return true; }
}
class FakeStdin extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.rawMode = false; }
  setRawMode(v) { this.rawMode = v; return this; }
  setEncoding() { return this; } resume() { return this; } pause() { return this; }
  ref() { return this; } unref() { return this; } read() { return null; }
}

/** 渲染一个 store 状态，返回 { lines, cursorY } */
async function renderState(mutate, columns = 80) {
  const stdout = new FakeStdout(columns);
  const store = new TuiStore();
  // 先走一轮，让 store 处于「已提交过」的状态（模拟发过消息）
  const p = store.readLine();
  store.insert('warmup');
  store.submit();
  await p;
  mutate?.(store);

  const tree = React.createElement(WindowSizeProvider, null,
    React.createElement(SessionApp, { store }));
  const inst = render(tree, {
    stdout, stderr: new FakeStdout(columns), stdin: new FakeStdin(),
    debug: false, patchConsole: false, exitOnCtrlC: false,
  });
  await new Promise(r => setTimeout(r, 350));
  inst.unmount();
  await new Promise(r => setTimeout(r, 80));
  const frame = lastFrame(stdout.buf);
  if (!frame) throw new Error('无法从输出中解析出帧（cursorSuffix 缺失）');
  return frame;
}

/** 输入框内容行的索引：`│ › ...` —— 用边框内的提示符定位 */
function contentRow(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/│\s*›/.test(lines[i])) return i;
  }
  return -1;
}

// ============================================================
console.log('\n=== 1. 几何：aboveRows 计入 inputY ===\n');
// ============================================================
{
  const bp = { narrow: false, compact: false };
  assert('无上方区块时 inputY = 2', computeInputGeometry(80, bp, 0).inputY === INPUT_OWN_ABOVE,
    `实际 ${computeInputGeometry(80, bp, 0).inputY}`);
  assert('aboveRows=2 时 inputY = 4', computeInputGeometry(80, bp, 2).inputY === 4,
    `实际 ${computeInputGeometry(80, bp, 2).inputY}`);
  assert('InputBox 自身上方占 2 行（marginTop + 上边框）', INPUT_OWN_ABOVE === 2);
  assert('状态行高度为 2（marginTop + 1 行文本）', ABOVE_BLOCK_HEIGHTS.status === 2);
  assert('x 与 aboveRows 无关（只影响 y）',
    computeInputGeometry(80, bp, 0).inputX === computeInputGeometry(80, bp, 2).inputX);
}

// ============================================================
console.log('\n=== 2. idle：光标落在输入框内容行 ===\n');
// ============================================================
{
  const { lines, cursorY } = await renderState(s => { s.insert('abc'); });
  const row = contentRow(lines);
  assert('找到输入框内容行', row > 0, `lines=${lines.length}`);
  assert(`idle 光标 y(${cursorY}) == 内容行(${row})`, cursorY === row,
    `光标上下 2 行: ${JSON.stringify(lines.slice(Math.max(0, cursorY - 2), cursorY + 3).map(l => l.slice(0, 30)))}`);
  assert('idle 光标 x 在 `› abc` 之后',
    lines[cursorY]?.slice(0, 12).includes('› abc'), JSON.stringify(lines[cursorY]?.slice(0, 20)));
}

// ============================================================
console.log('\n=== 3. busy：状态行出现后光标仍落在输入框内容行 ===\n');
// ============================================================
{
  const { lines, cursorY } = await renderState(s => {
    s.setBusy(true);
    s.setStatus({ main: 'Thinking', detail: 'analyzing', startedAt: Date.now(), lastChangeAt: Date.now() });
  });
  const row = contentRow(lines);
  assert('busy 时有状态行', lines.some(l => /Thinking/.test(l)),
    JSON.stringify(lines.filter(l => /Thinking/.test(l)).slice(0, 1)));
  assert('busy 时输入框仍渲染', row > 0);
  // ← 这就是原 bug：改前 cursorY === row - 2
  assert(`busy 光标 y(${cursorY}) == 内容行(${row})`, cursorY === row,
    `偏移 ${cursorY - row} 行；附近: ${JSON.stringify(lines.slice(Math.max(0, row - 3), row + 2).map(l => l.slice(0, 30)))}`);
}

// ============================================================
console.log('\n=== 4. busy + 输入内容 + 队列：三者共存时光标正确 ===\n');
// ============================================================
{
  const { lines, cursorY } = await renderState(s => {
    s.setBusy(true);
    s.setStatus({ main: 'Thinking', detail: 'analyzing', startedAt: Date.now(), lastChangeAt: Date.now() });
    s.insert('正在输入');
    // 再塞两条进队列（运行中提交 → 入队）
    s.submit();
    s.insert('第二条');
    s.submit();
    s.insert('正在输入2');
  });
  const row = contentRow(lines);
  assert('光标仍在输入框内容行', cursorY === row, `光标 ${cursorY} / 内容行 ${row}`);
  // 队列入队顺序：第一个 submit 入队 '正在输入'，第二个入队 '第二条'。
  // 托盘编号从 1 开始 → '1. 正在输入' / '2. 第二条'。
  // 托盘现在在输入框**上方**：阅读顺序 = 时间顺序（队列「已提交、即将执行」，
  // 逻辑上先于正在输入的内容）。关键不变量是「光标仍落在内容行」——
  // 托盘上移后必须计入 aboveRows，否则光标会偏上（L26 同类风险）。
  // 托盘无序号（位置即顺序），用 › 前缀识别
  const trayRow = lines.findIndex(l => /›\s*正在输入/.test(l));
  assert('队列托盘渲染在输入框上方', trayRow >= 0 && trayRow < row,
    `托盘行=${trayRow} 内容行=${row}`);
  assert('托盘第二条也列出', lines.some(l => /›\s*第二条/.test(l)),
    JSON.stringify(lines.filter(l => /›/.test(l))));
}

// ============================================================
console.log('\n=== 5. 多行输入：光标跟着折行后的行 ===\n');
// ============================================================
{
  const { lines, cursorY } = await renderState(s => {
    s.setBusy(true);
    s.insert('第一行\n第二行\n第三行');
  }, 40);
  const rows = lines.map((l, i) => (/│.*第[一二三]行/.test(l) ? i : -1)).filter(i => i >= 0);
  assert('三行内容各自渲染在不同行', rows.length === 3, `匹配 ${rows.length} 行`);
  if (rows.length === 3) {
    assert('光标落在最后一行（第三行）', cursorY === rows[2],
      `光标 ${cursorY} / 第三行 ${rows[2]}`);
  }
}

// ============================================================
console.log('\n=== 6. 源码不变量：渲染条件与高度计算同源 ===\n');
// ============================================================
{
  const app = readFileSync(join(SRC, 'cli/tui/SessionApp.tsx'), 'utf8');
  // 不允许出现两处独立的可见性判断（一处渲染状态行、一处算高度）。
  // 改前是 state.busy；现在状态行可见性改由观察者快照决定（state.status），
  // 但「一处产出、两处消费」这条不变量不变。
  assert('用一个变量决定状态行是否可见', /const statusVisible = state\.status != null/.test(app));
  // 断言意图而非字面表达式：aboveRows 必须由「可见性 + 托盘高度」共同推出，
  // 且托盘高度只能来自 queueRows() 这一个来源（两处独立判断就会漂移 → 光标偏上）。
  assert('aboveRows 由 statusVisible 与 queueRows 共同推出',
    /const aboveRows = \(statusVisible \? ABOVE_BLOCK_HEIGHTS\.status : 0\) \+ queueRows\(state\.queue\.length\)/.test(app));
  assert('状态行渲染用 statusVisible', /\{statusVisible &&/.test(app));
  assert('托盘渲染条件与高度同源（都用 queueRows）',
    /queueRows\(state\.queue\.length\) > 0 &&/.test(app));
  assert('InputBox 收到 aboveRows', /aboveRows=\{aboveRows\}/.test(app));
  assert('不再硬编码 inputY = 2（geometry 里改由 aboveRows 参数推导）',
    !/inputY:\s*2,/.test(readFileSync(join(SRC, 'cli/tui/layout/geometry.ts'), 'utf8')));

  const status = readFileSync(join(SRC, 'cli/tui/render/status.tsx'), 'utf8');
  assert('状态文本压掉换行（保证恒 1 行，高度可预测）',
    /replace\(\/\[\\r\\n\]\+\/g, ' '\)/.test(status));
}

// ============================================================
console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
