// 运行时验证：真实启动 Ink，测 stdout resize 监听器峰值
// 用法: node Plan/cli-test/test-window-size-runtime.mjs（需先 npm run build）
//
// 之前的现象：恢复历史时 restoreHistory() 一次 appendBatch 推入 N 条，
// <Static> 同帧挂载 N 个组件 → 每个组件各挂一个 resize 监听器 →
// 超过 Node 默认 maxListeners(10) → MaxListenersExceededWarning。
//
// 本测试真实渲染 SessionApp（含 ToolLine/MarkdownBlock/ThoughtBlock），断言：
//   1. 监听器峰值 ≤ 1
//   2. 过程不出现 MaxListenersExceededWarning
//   3. 尺寸确实通过 context 下发
//
// 用假 stdout（可控列数 + 能数监听器 + 不污染终端）而非 process.stdout。
import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const D = new URL('../dist/', import.meta.url).pathname;
const { TuiStore } = await import(D + 'cli/tui/store.js');
const { SessionApp } = await import(D + 'cli/tui/SessionApp.js');
const { WindowSizeProvider, useTerminalSize } = await import(D + 'cli/tui/layout/window-size.js');

/** 假 stdout：EventEmitter + 可写流接口，记录 resize 监听器峰值 */
class FakeStdout extends EventEmitter {
  constructor(columns = 100, rows = 30) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = true;
    this.peakResizeListeners = 0;
  }
  on(event, listener) {
    const r = super.on(event, listener);
    if (event === 'resize') {
      this.peakResizeListeners = Math.max(this.peakResizeListeners, this.listenerCount('resize'));
    }
    return r;
  }
  off(event, listener) { return super.off(event, listener); }
  removeListener(event, listener) { return super.removeListener(event, listener); }
  write() { return true; }
}

// ---- 抓 warning ----
const warnings = [];
const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  warnings.push(typeof warning === 'string' ? warning : warning?.message ?? '');
  return origEmitWarning.call(process, warning, ...rest);
};

/**
 * 基线：ink 自己就挂 1 个 resize（node_modules/ink/build/ink.js:326 → this.resized），
 * 用于内部重绘。所以「正确」的常量是 2 = ink 1 + 我们的 provider 1。
 *
 * 关键不是这个数字，而是它**不随组件数量增长**：改前是 1 + N（N = 同帧挂载的日志项）。
 * 测试 1/2 用不同 N 验证「峰值相同」，Test 1b 特意用少量项做对照。
 */
const BASELINE = 2;

// ============================================================
console.log('\n=== 1. 一次推入 30 条（复现"恢复历史"的调用形态）===\n');
// ============================================================
{
  const stdout = new FakeStdout(100, 30);
  const store = new TuiStore();
  store.appendWelcome({ version: '1.1.1', model: 'test', provider: 'openai', mode: '云端', tools: '18', cwd: '~', memory: '~' });

  const batch = [];
  for (let i = 0; i < 30; i++) {
    if (i % 3 === 0) batch.push({ kind: 'user', text: `用户发言 ${i}` });
    else if (i % 3 === 1) batch.push({ kind: 'md', text: `助手回复 **${i}**` });
    else batch.push({ kind: 'tool', text: 'Bash', meta: { name: 'Bash', args: `cmd-${i}` } });
  }
  store.appendBatch(batch);

  const inst = render(
    React.createElement(WindowSizeProvider, null, React.createElement(SessionApp, { store })),
    { stdout, debug: false, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(r => setTimeout(r, 500));
  inst.unmount();
  await new Promise(r => setTimeout(r, 150));

  assert(`渲染 30 条日志时监听器峰值 = ${BASELINE}（ink 1 + provider 1）`,
    stdout.peakResizeListeners === BASELINE, `峰值 ${stdout.peakResizeListeners}`);
  assert('卸载后监听器归零', stdout.listenerCount('resize') === 0,
    `残留 ${stdout.listenerCount('resize')}`);
  assert('没有触发 MaxListenersExceededWarning',
    !warnings.some(w => /MaxListeners/i.test(w)),
    JSON.stringify(warnings.filter(w => /MaxListeners/i.test(w)).slice(0, 2)));
}

// ============================================================
console.log('\n=== 1b. 对照：只渲染 3 条时峰值与 30 条相同（关键回归）===\n');
// ============================================================
// 这一条是本次修复的核心断言：改前峰值 = 1 + N（随日志项线性增长），
// 改后峰值是常量。所以「3 条」和「30 条」必须相等，
// 而不是「都小于某个大数字」。
{
  const stdout = new FakeStdout(100, 30);
  const store = new TuiStore();
  store.appendBatch([
    { kind: 'tool', text: 'Bash', meta: { name: 'Bash', args: 'a' } },
    { kind: 'md', text: 'b' },
    { kind: 'user', text: 'c' },
  ]);
  const inst = render(
    React.createElement(WindowSizeProvider, null, React.createElement(SessionApp, { store })),
    { stdout, debug: false, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(r => setTimeout(r, 400));
  inst.unmount();
  await new Promise(r => setTimeout(r, 150));

  assert('3 条与 30 条的监听器峰值相同（说明不随组件数增长）',
    stdout.peakResizeListeners === BASELINE, `3 条峰值 ${stdout.peakResizeListeners}`);
}

// ============================================================
console.log('\n=== 2. 分 10 批追加共 100 条（模拟持续对话）===\n');
// ============================================================
{
  const stdout = new FakeStdout(100, 30);
  const store = new TuiStore();
  const inst = render(
    React.createElement(WindowSizeProvider, null, React.createElement(SessionApp, { store })),
    { stdout, debug: false, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(r => setTimeout(r, 250));

  for (let b = 0; b < 10; b++) {
    const items = [];
    for (let i = 0; i < 5; i++) {
      items.push({ kind: 'tool', text: 'Bash', meta: { name: 'Bash', args: `b${b}-${i}` } });
      items.push({ kind: 'toolResult', text: `输出 ${b}-${i}`, meta: { totalLines: 1, shownLines: 1, truncated: false } });
    }
    store.appendBatch(items);
    await new Promise(r => setTimeout(r, 120));
  }
  await new Promise(r => setTimeout(r, 350));
  inst.unmount();
  await new Promise(r => setTimeout(r, 150));

  assert(`10 批 / 共 100 条，监听器峰值仍是 ${BASELINE}（不随日志增长）`,
    stdout.peakResizeListeners === BASELINE, `峰值 ${stdout.peakResizeListeners}`);
  assert('全程无 MaxListeners 警告', !warnings.some(w => /MaxListeners/i.test(w)));
}

// ============================================================
console.log('\n=== 3. context 真的下发了尺寸 ===\n');
// ============================================================
{
  const stdout = new FakeStdout(137, 41);
  let seen = null;
  function Probe() { seen = useTerminalSize(); return null; }
  const inst = render(
    React.createElement(WindowSizeProvider, null, React.createElement(Probe, null)),
    { stdout, debug: false, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(r => setTimeout(r, 250));
  inst.unmount();
  await new Promise(r => setTimeout(r, 100));

  assert('组件拿到了尺寸对象', seen !== null && typeof seen.columns === 'number');
  assert('columns 来自终端（137，不是写死 80）', seen?.columns === 137, String(seen?.columns));
  assert('rows 来自终端（41，不是写死 24）', seen?.rows === 41, String(seen?.rows));
}

// ============================================================
console.log('\n=== 4. resize 事件能传到组件（context 会更新）===\n');
// ============================================================
{
  const stdout = new FakeStdout(100, 30);
  const history = [];
  function Probe() { history.push(useTerminalSize().columns); return null; }
  const inst = render(
    React.createElement(WindowSizeProvider, null, React.createElement(Probe, null)),
    { stdout, debug: false, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(r => setTimeout(r, 250));
  stdout.columns = 60;
  stdout.emit('resize');
  await new Promise(r => setTimeout(r, 250));
  inst.unmount();
  await new Promise(r => setTimeout(r, 100));

  assert('初始拿到 100', history.includes(100), JSON.stringify(history));
  assert('resize 后更新到 60', history.includes(60), JSON.stringify(history));
  assert(`监听器峰值 = ${BASELINE}（ink 1 + provider 1）`,
    stdout.peakResizeListeners === BASELINE, `峰值 ${stdout.peakResizeListeners}`);
}

// ============================================================
console.log('\n=== 5. 没有 provider 时不崩（renderToString / 单测场景）===\n');
// ============================================================
{
  const stdout = new FakeStdout();
  let seen = null;
  function Probe() { seen = useTerminalSize(); return null; }
  let threw = null;
  try {
    const inst = render(React.createElement(Probe, null),
      { stdout, debug: false, patchConsole: false, exitOnCtrlC: false });
    await new Promise(r => setTimeout(r, 200));
    inst.unmount();
  } catch (e) { threw = e; }
  await new Promise(r => setTimeout(r, 100));

  assert('无 provider 时不抛异常', threw === null, threw?.message);
  assert('无 provider 时拿到 fallback 尺寸', seen !== null && typeof seen.columns === 'number',
    JSON.stringify(seen));
  assert('无 provider 时不挂 resize 监听器', stdout.listenerCount('resize') === 0,
    `残留 ${stdout.listenerCount('resize')}`);
}

// ---- 收尾 ----
process.emitWarning = origEmitWarning;

console.log(`\n结果: ${PASS} 通过, ${FAIL} 失败\n`);
process.exit(FAIL === 0 ? 0 : 1);
