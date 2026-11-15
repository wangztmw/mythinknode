// TUI 指令队列回归测试 —— 运行中也能继续输入，按 Enter 入队
//
// 用法: npm run build && node Plan/cli-test/test-tui-queue.mjs
//
// ## 为什么需要这个测试
//
// 改前 `SessionApp` 是 `{state.waiting && <InputBox/>}` —— 一轮开始输入框整个被卸载，
// 用户想补充一句只能干等几十秒。而等待期间人的思路是连续的，被迫中断要么忘掉，
// 要么得重述上下文。这属于「让人脑节奏适配机器节奏」的反面。
//
// 改动的核心是**只改状态机语义，不动主循环**：
//   - submit() 在 resolveLine 为 null（运行中）时入队，而不是丢弃
//   - readLine() 队列优先，同步 resolve —— 主循环 while(true) 一行不用改
//
// 本测试锁死四条不变量：
//   1. 队列严格 FIFO，且 readLine 会立刻消费队首（不需要用户再按回车）
//   2. 入队时不写日志、出队时才写日志（否则中断取消后 <Static> 已打印的行无法回改）
//   3. 中断清空队列，但条目已进 history（↑ 可找回，绝不静默丢字）
//   4. 输入框与队列托盘在任意宽度下都不溢出（L23/L24 的结论）

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

const { TuiStore } = await import(D + 'cli/tui/store.js');

/**
 * 造一个「运行中」的 store：先走一次正常提交（结束 readLine），
 * 此时 waiting=false、resolveLine=null，等价于 agent 正在跑。
 */
function runningStore() {
  const store = new TuiStore();
  const p = store.readLine();
  store.insert('warmup');
  store.submit();
  p.then(() => {});
  return store;
}

const userLogs = (store) => store.getSnapshot().log.filter(i => i.kind === 'user').map(i => i.text);

// ============================================================
console.log('\n=== 1. 运行中提交入队（不再丢弃） ===\n');
// ============================================================
{
  const store = runningStore();
  assert('运行中 waiting = false', store.getSnapshot().waiting === false);

  store.insert('第二条指令');
  assert('运行中可以输入字符（改前被丢弃）', store.getSnapshot().input === '第二条指令');

  store.submit();
  const s = store.getSnapshot();
  assert('提交后进入队列', s.queue.length === 1 && s.queue[0] === '第二条指令');
  assert('提交后输入框清空', s.input === '');
  assert('提交后光标归零', s.cursor === 0);
  assert('入队不写 user 日志（出队时才写）',
    userLogs(store).length === 1 && userLogs(store)[0] === 'warmup',
    JSON.stringify(userLogs(store)));
}

// ============================================================
console.log('\n=== 2. FIFO 顺序 + readLine 立刻消费队首 ===\n');
// ============================================================
{
  const store = runningStore();
  for (const t of ['A', 'B', 'C']) { store.insert(t); store.submit(); }
  assert('连续入队 3 条', store.getSnapshot().queue.join(',') === 'A,B,C');

  const first = await store.readLine();
  assert('readLine 返回队首 A（严格 FIFO）', first === 'A');
  assert('出队后队列剩 2 条', store.getSnapshot().queue.join(',') === 'B,C');
  assert('出队即写 user 日志（此刻才是「用户说过」）', userLogs(store).includes('A'));

  // 队列非空时 readLine 必须**同步**resolve —— 早返回 = 立刻开始下一轮，不需要再按回车
  let syncResolved = false;
  const p = store.readLine();
  p.then(() => { syncResolved = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert('队列非空时 readLine 同步 resolve（不需要用户再按回车）', syncResolved);
  assert('第二条拿到 B', (await p) === 'B');

  assert('最后一条拿到 C', (await store.readLine()) === 'C');
  assert('队列已空', store.getSnapshot().queue.length === 0);

  // 队列空之后回到阻塞等待
  const pending = store.readLine();
  const timeout = new Promise(r => setTimeout(() => r('TIMEOUT'), 60));
  assert('队列空时 readLine 阻塞等待（不空转）', (await Promise.race([pending, timeout])) === 'TIMEOUT');
  assert('阻塞时 waiting = true（输入框回到空闲语义）', store.getSnapshot().waiting === true);
  store.insert('release'); store.submit();
  assert('阻塞后被正常提交唤醒', (await pending) === 'release');
}

// ============================================================
console.log('\n=== 3. 中断清空队列，但绝不静默丢字 ===\n');
// ============================================================
{
  const store = runningStore();
  store.insert('会被取消的指令'); store.submit();
  assert('入队成功', store.getSnapshot().queue.length === 1);

  // 注入中断处理器（模拟主循环在一轮执行时注册的那个）
  store.interruptHandler = () => true;
  const handled = store.requestInterrupt();
  assert('requestInterrupt 返回 true（有可打断目标）', handled === true);
  assert('中断后队列被清空（否则「按了 Esc 还在跑」）', store.getSnapshot().queue.length === 0);

  const sys = store.getSnapshot().log.filter(i => i.kind === 'system').map(i => i.text);
  assert('提示里说明了取消条数', sys.some(t => t.includes('1 条') && t.includes('取消')),
    JSON.stringify(sys));

  // 被取消的条目必须能从 history 找回
  store.historyPrev();
  assert('被取消的条目能用 ↑ 召回（不静默丢字）',
    store.getSnapshot().input === '会被取消的指令', JSON.stringify(store.getSnapshot().input));
}

// ============================================================
console.log('\n=== 4. clearQueue：只清队列，不中断 ===\n');
// ============================================================
{
  const store = runningStore();
  store.insert('x'); store.submit();
  store.insert('y'); store.submit();

  let interrupted = 0;
  store.interruptHandler = () => { interrupted++; return true; };

  const n = store.clearQueue();
  assert('clearQueue 返回清掉的条数', n === 2);
  assert('队列已空', store.getSnapshot().queue.length === 0);
  assert('clearQueue 不触发中断（只为清队列提供独立出口）', interrupted === 0);

  assert('队列本来就空时返回 0', store.clearQueue() === 0);

  store.historyPrev();
  assert('清空的条目仍可召回', store.getSnapshot().input === 'y');
}

// ============================================================
console.log('\n=== 5. 提示行文案随状态变化 ===\n');
// ============================================================
{
  const { hintText } = await import(D + 'cli/tui/layout/limits.js');
  const wide = { narrow: false, compact: false };
  const narrow = { narrow: true, compact: true };

  const idle = hintText(wide, { running: false, queued: 0 });
  const run = hintText(wide, { running: true, queued: 0 });
  assert('空闲提示保留原有文案（Enter 发送）', idle.includes('Enter 发送'), idle);
  assert('运行中提示改为「排队」（否则用户以为按键失灵）', run.includes('Enter 排队发送'), run);
  assert('运行中提示给出中断出口', run.includes('Esc 中断'), run);

  const queued = hintText(wide, { running: true, queued: 2 });
  assert('有队列时提示条数与清空方式',
    queued.includes('队列 2 条') && queued.includes('Ctrl+X'), queued);

  const nRun = hintText(narrow, { running: true, queued: 1 });
  assert('narrow 运行中走精简文案', nRun.startsWith('Enter 排队'), nRun);
  assert('narrow 不出现 Ctrl+U/Ctrl+W（窄屏放不下）', !nRun.includes('Ctrl+U'), nRun);
}

// ============================================================
console.log('\n=== 6. 源码结构不变量 ===\n');
// ============================================================
{
  const app = readFileSync(join(SRC, 'cli/tui/SessionApp.tsx'), 'utf8');

  assert('不再有 `if (!state.waiting) return;` 输入闸门',
    !/if \(!state\.waiting\) return;/.test(app));

  // 输入框必须常驻：不能出现在 `{state.waiting && ...}` 条件里
  const inputIdx = app.indexOf('<InputBox');
  assert('InputBox 存在于渲染树', inputIdx > 0);
  const before = app.slice(Math.max(0, inputIdx - 200), inputIdx);
  assert('InputBox 不被 waiting 条件包裹（运行中也显示）',
    !/\{\s*state\.waiting\s*&&\s*\(\s*$/.test(before.trim().slice(-60)),
    JSON.stringify(before.trim().slice(-40)));

  assert('有队列托盘组件', /function QueueTray/.test(app));
  // 托盘移到输入框**上方**：阅读顺序 = 时间顺序（队列「已提交、即将执行」先于正在输入的内容）。
  // 关键配套是不变量：托盘占的行数必须计入 aboveRows，否则光标偏上（L26 同类风险）。
  assert('托盘渲染在输入框之前（阅读顺序=时间顺序）',
    app.indexOf('<QueueTray') < inputIdx && app.indexOf('<QueueTray') > 0);
  assert('托盘高度计入 aboveRows', /queueRows\(state\.queue\.length\)/.test(app));
  assert('托盘渲染条件与高度同源', /queueRows\(state\.queue\.length\) > 0 &&/.test(app));

  // 托盘宽度必须自己算（L23/L24：不交给 Yoga）
  const trayIdx = app.indexOf('function QueueTray');
  const trayBody = app.slice(trayIdx, trayIdx + 900);
  assert('托盘宽度用 contentWidth 自算', trayBody.includes('contentWidthOf('));
  assert('托盘条目不使用 flexGrow 承载宽度', !trayBody.includes('flexGrow'));
  assert('托盘条目用 truncateToWidth 兜底', trayBody.includes('truncateToWidth'));

  // Ctrl+X 必须在中断分支之后、普通按键之前，且只清队列
  assert('Ctrl+X 清空队列', /input === 'x'[\s\S]{0,120}clearQueue\(\)/.test(app));

  const storeSrc = readFileSync(join(SRC, 'cli/tui/store.ts'), 'utf8');
  assert('submit 在无 resolveLine 时入队而非 return',
    /if \(this\.resolveLine\)[\s\S]*?queue: \[\.\.\.this\.state\.queue, text\]/.test(storeSrc));
  assert('readLine 队列优先（queue[0] 分支在 new Promise 之前）',
    storeSrc.indexOf('this.state.queue[0]') < storeSrc.indexOf('new Promise(resolve => { this.resolveLine = resolve; })'));
}

// ============================================================
console.log('\n=== 7. 渲染：输入框 + 托盘不溢出 ===\n');
// ============================================================
{
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const { SessionApp } = await import(D + 'cli/tui/SessionApp.js');
  const { WindowSizeProvider } = await import(D + 'cli/tui/layout/window-size.js');

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

  const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  const OSC = /\x1b\][^\x07]*\x07/g;
  const strip = (s) => s.replace(OSC, '').replace(ANSI, '');
  const dw = (line) => {
    let w = 0;
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
        || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
        || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
        || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f9ff);
      w += wide ? 2 : 1;
    }
    return w;
  };

  async function renderStore(mutate, columns) {
    const stdout = new FakeStdout(columns);
    const store = runningStore();
    mutate(store);
    const tree = React.createElement(WindowSizeProvider, null,
      React.createElement(SessionApp, { store }));
    const inst = render(tree, {
      stdout, stderr: new FakeStdout(columns), stdin: new FakeStdin(),
      debug: false, patchConsole: false, exitOnCtrlC: false,
    });
    await new Promise(r => setTimeout(r, 320));
    inst.unmount();
    await new Promise(r => setTimeout(r, 80));
    return strip(stdout.buf).split('\n');
  }

  const LONG = '这是一条很长的待发送指令，用来验证队列托盘在窄终端下不会溢出屏幕宽度，并且会被正确截断而不是折到下一行';

  for (const cols of [20, 40, 60, 80, 120]) {
    const lines = await renderStore((s) => {
      s.setBusy(true);                       // 模拟运行中
      s.insert(LONG); s.submit();
      s.insert('第二条'); s.submit();
    }, cols);
    const over = lines.filter(l => dw(l) > cols);
    assert(`${cols}列 运行中(输入框+托盘) 不溢出`, over.length === 0,
      over.slice(0, 2).map(l => `[${dw(l)}]${l.slice(0, 30)}`).join(' | '));
  }

  {
    const lines = await renderStore((s) => {
      s.setBusy(true);
      for (const t of ['一', '二', '三', '四', '五']) { s.insert(t); s.submit(); }
    }, 80);
    const body = lines.join('\n');
    // 学 Claude Code：靠结构区分而非标签/颜色 —— gray 单色、`›` 前缀、无标题无序号。
  assert('★ 托盘用 › 前缀（与输入框提示符同形，表示"这也是我要发的消息"）',
    /›\s+一/.test(body), body.slice(0, 200));
  assert('★ 托盘不带「待发送」之类的标签（信息靠位置，不靠标签）',
    !/待发送/.test(body));
  assert('★ 托盘不带序号（位置本身就是顺序）',
    !/›\s*1\./.test(body));
  assert('托盘显示前 3 条', body.includes('一') && body.includes('二') && body.includes('三'),
      JSON.stringify(lines.filter(l => /\d\. /.test(l))));
    assert('超出部分折叠为「还有 N 条」', body.includes('还有 2 条'));
    assert('运行中提示为「排队」', body.includes('Enter 排队发送'));
    assert('有队列时提示清空方式', body.includes('Ctrl+X'));
    assert('托盘里不出现第 4 条（折叠生效）', !body.includes('四'));
  }

  {
    // 运行中但队列为空：输入框仍在，托盘不渲染
    const lines = await renderStore((s) => { s.setBusy(true); }, 80);
    const body = lines.join('\n');
    assert('运行中无队列时输入框仍显示', body.includes('›') || body.includes('运行中'));
    assert('运行中空队列不显示托盘占位', !body.includes('… 还有'));
  }
}

// ============================================================
console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
