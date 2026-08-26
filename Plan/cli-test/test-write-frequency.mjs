// 写频回归 —— 量化「备用屏原地修改 vs 主屏流式」三个崩溃相关指标，并验证最终屏正确
// 用法: node Plan/cli-test/test-write-frequency.mjs（需先 npm run build）
//
// 背景：Terminal.app SIGTRAP（.ips 崩溃报告）污染源 =「高频写入」——每次 PTY 写让 SwiftUI
// 分配/释放小对象 → nano zone 碎片化。用户实测进一步定位：触发器是「一次输出的换行数
// （滚动爆发）」——一个 \n 滚屏 = 终端一次内部 scroll + SwiftUI 整屏重排 = 大量小对象。
//
// 所以本测试量三个指标：
//   1. 字面 \n 数（滚动爆发，致命指标）—— 备用屏应 0 个（原地修改结构性消除）；
//   2. emit 调用次数（写频率）—— 备用屏每 flush 一次写，不逐行写；
//   3. 总字节数（次要，滚动时备用屏反而更贵：视口上移→整屏重写，如实记录）。
// 并断言：状态行 tick 只写变化 cell、最终屏内容正确。
import { AltScreenState } from '../../dist/cli/render/screen-state-alt.js';
import { MainScreenState } from '../../dist/cli/render/screen-state-main.js';

const ROWS = 24, COLS = 80;
const N = 6; // 6 轮对话，总行数 > 24，足以触发视口滚动

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

// 捕获 flush 的所有字节 + emit 调用次数（覆盖 ss.emit，ScreenBuffer 的 out 回调经 this.emit 转发）
function capture(State, opts) {
  let out = '';
  let calls = 0;
  const ss = new State('P> ', opts);
  ss.emit = (raw) => { out += raw; calls++; };
  return { ss, get out() { return out; }, get calls() { return calls; } };
}

// 脚本化一轮对话：输入 → thinking → tick×2 → 工具 → thinking_end → 结果
// 与 renderer.ts 的 ProgressEvent → ScreenState 调用一一对应（不含 tick 合并定时器，纯同步）。
function runRound(ss, i) {
  ss.printPrompt();
  ss.submitInput(`帮我写一个函数，这是第 ${i} 轮`);
  ss.beginStatus(`  ● Thinking (0.0s) — analyzing`, i > 1); // 第 1 轮填回车空行，之后前导换行
  ss.overwriteStatus(`  ● Thinking (1.0s) — analyzing`);
  ss.overwriteStatus(`  ● Thinking (2.0s) — analyzing`);
  ss.displayTools([`  ● Bash (2.0s): ls -la  → 这是第 ${i} 轮的示例工具输出`]);
  ss.endStatus(`  ● Thinking (2.5s) — analyzing → 1 tool`);
  ss.writeLines(`\n这是第 ${i} 轮的最终回答：一段足够长的文本用来测试输出追加与视口滚动。\n[2.5s | in: 10, out: 20]`);
}

console.log('\n=== 写频回归（备用屏 vs 主屏）===\n');

// ---- 备用屏（原地修改）----
{
  const c = capture(AltScreenState, { rows: ROWS, cols: COLS });
  for (let i = 1; i <= N; i++) runRound(c.ss, i);
  const nl = (c.out.match(/\n/g) || []).length;

  assert(`备用屏：全程 0 个字面换行 \\n（滚动爆发被结构性消除）`, nl === 0);

  // 状态行 tick：只变秒数一位，diff 只写那一个 cell，字节远小于整行
  const c2 = capture(AltScreenState, { rows: ROWS, cols: COLS });
  c2.ss.beginStatus(`  ● Thinking (0.0s) — analyzing`, false);
  const before = c2.out.length;
  c2.ss.overwriteStatus(`  ● Thinking (1.0s) — analyzing`);
  const tickDelta = c2.out.length - before;
  assert(`备用屏：状态行 tick 只写变化 cell（${tickDelta} 字节 < 20）`, tickDelta > 0 && tickDelta < 20);

  // 最终屏正确：最后一轮 thinking 定稿 + 回答都在
  const joined = c.ss.snapshot().join('\n');
  assert('备用屏：最后一轮 thinking 定稿在屏上', joined.includes('Thinking (2.5s) — analyzing → 1 tool'));
  assert(`备用屏：最后一轮回答在屏上`, joined.includes(`这是第 ${N} 轮的最终回答`));

  console.log(`  [备用屏] emit ${c.calls} 次 · 字面换行 ${nl} 次 · 总字节 ${c.out.length}`);
}

// ---- 主屏（流式）----
{
  const c = capture(MainScreenState, {});
  for (let i = 1; i <= N; i++) runRound(c.ss, i);
  const nl = (c.out.match(/\n/g) || []).length;
  assert('主屏：有字面换行 \\n（滚动爆发，备用屏已消除）', nl > 0);
  console.log(`  [主屏] emit ${c.calls} 次 · 字面换行 ${nl} 次 · 总字节 ${c.out.length}`);
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
