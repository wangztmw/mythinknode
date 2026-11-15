// 主循环抗崩溃回归测试 —— 复现「终端突然无法输入字符」
//
// 根因链路（TUI 模式）：
//   TuiStore.readLine() → waiting = true   （可以输入）
//   TuiStore.submit()   → waiting = false  （不可输入）
//   SessionApp.useInput: `if (!state.waiting) return;` → 所有按键被静默丢弃
//
// 所以只要主循环某轮抛异常逃出 while(true)，waiting 就永久停在 false：
// 进程还活着（stdin 正常、raw mode 正常、栈阻塞在 read()），Ctrl+C 还能退，
// 但普通字符、回车、退格全部无反应。而 console.error 写在 TUI 备用屏上，看不见。
//
// 本测试锁死两条不变量：
//   1. 一轮抛异常（runSession / renderResult / stopRender / session.save）后，
//      主循环必须继续并再次进入「可输入」状态
//   2. 异常必须以用户可见的方式渲染出来
//
// 用法: npm run build && node Plan/cli-test/test-loop-resilience.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../src');

/** 从 `{` 开始按括号配对取出整块（源码结构断言用，避免按行距切片 — L09） */
function extractBlock(src, fromIdx) {
  const open = src.indexOf('{', fromIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

// ---- 1. 源码级不变量：主循环体整体被 try/finally 保护 ----
// （主循环跑在真实 stdin/LLM 上，无法在单测里驱动，所以用结构断言锁住）
console.log('\n=== 主循环抗崩溃结构 ===\n');
{
  const src = readFileSync(join(SRC, 'Mythinknode.ts'), 'utf8');

  assert('主循环存在 while (true)', /while \(true\)/.test(src));

  // 从 "if (!line) continue;" 到 "finally {" 之间必须包含 setBusy(true)
  const tail = src.slice(src.indexOf('if (!line) continue;'));
  const finallyIdx = tail.indexOf('finally {');
  assert('一轮处理被 try/finally 包裹（存在 finally）', finallyIdx > 0);

  const guarded = tail.slice(0, finallyIdx);
  assert('renderResult 在 try 块内（不在 finally 之后裸奔）',
    guarded.includes('cli.renderResult('));
  assert('runSession 在 try 块内',
    guarded.includes('await runSession('));
  assert('stopRender 在 try 块内可被 finally 前的 catch 兜底',
    guarded.includes('stopRender'));

  // ⚠️ 不按固定行距切片（L09）：finally 块里加了注释就会超出窗口、误报。
  // 改为按「块边界」取：从 `finally {` 到它自己闭合的 `}`。
  const finBlock = extractBlock(tail, finallyIdx);
  assert('finally 里调用 cli.setBusy(false)（放开输入）',
    /setBusy\(false\)/.test(finBlock), finBlock.slice(0, 200));
  assert('finally 里调用 session.save()',
    /session\.save\(\)/.test(finBlock), finBlock.slice(0, 200));
  assert('finally 里调用 resetPhase()（复位快照，防心跳接旧时间）',
    /resetPhase\b/.test(finBlock), '快照不复位 → 下一轮状态行会从上一轮的时间开始计');

  // 关键反例：setBusy(false) 不能出现在任何「可能被跳过的裸语句」位置
  // （原 bug 就是 renderResult 抛异常后 setBusy(false) 被跳过）
  // 注意：不能按"行距在 N 行以内"判断 —— 中间插一个代码块就会误报（已踩过一次）。
  // 改为位置索引：finally 必须出现在 while(true) 内部、且在 `if (!line) continue;` 之后。
  const whileIdx = src.indexOf('while (true)');
  const loopTailIdx = src.indexOf('if (!line) continue;', whileIdx);
  const finallyIdx2 = src.indexOf('finally {', loopTailIdx);
  assert('if (!line) continue; 在主循环内', whileIdx > 0 && loopTailIdx > whileIdx);
  assert('找到主循环的 finally 块（结构判断，不依赖行距）',
    finallyIdx2 > loopTailIdx, `while=${whileIdx} line=${loopTailIdx} finally=${finallyIdx2}`);
}

// ---- 2. SessionApp 的输入总开关语义 ----
// 2026-11-14 起输入闸门被拆掉（运行中也要能输入 → 入队）。
// 见 Plan/20261114-1134-tui-command-queue。所以这里断言的是「没有闸门」，
// 而中断/退出的优先级仍然必须在普通按键之前。
console.log('\n=== TUI 输入总开关 ===\n');
{
  const app = readFileSync(join(SRC, 'cli/tui/SessionApp.tsx'), 'utf8');
  assert('useInput 里不再有 `if (!state.waiting) return;` 输入闸门（运行中可输入）',
    !/if \(!state\.waiting\) return;/.test(app));

  // Ctrl+C / Ctrl+D 必须排在普通按键处理之前，保证任何时候都能中断/退出
  const ctrlIdx = app.indexOf("key.ctrl && (input === 'c' || input === 'd')");
  const submitIdx = app.indexOf('if (key.return) store.submit();');
  assert('Ctrl+C 处理在普通按键处理之前（任何时候都能中断/退出）',
    ctrlIdx > 0 && submitIdx > 0 && ctrlIdx < submitIdx);

  const escIdx = app.indexOf('if (key.escape)');
  assert('Esc 处理在普通按键处理之前', escIdx > 0 && escIdx < submitIdx);
}

// ---- 3. TuiStore 的 waiting 生命周期 ----
console.log('\n=== TuiStore.waiting 生命周期 ===\n');
{
  const storeSrc = readFileSync(join(SRC, 'cli/tui/store.ts'), 'utf8');
  const readLineBody = storeSrc.slice(storeSrc.indexOf('readLine(): Promise<string>'));
  const submitBody = storeSrc.slice(storeSrc.indexOf('submit(): void'));

  assert('readLine() 置 waiting = true',
    /readLine\(\): Promise<string> \{[\s\S]{0,900}?waiting: true/.test(storeSrc));
  assert('submit() 置 waiting = false',
    /submit\(\): void \{[\s\S]{0,900}?waiting: false/.test(storeSrc));
  assert('readLine 在 submit 之前定义（顺序无关，但两者都存在）',
    storeSrc.indexOf('readLine(): Promise<string>') > 0 && storeSrc.indexOf('submit(): void') > 0);
  // 迁移点必须穷举 —— 多一处就是状态机漏洞，少一处就是死锁。
  // 现在有 3 处：readLine 队列快路径(false) / readLine 慢路径(true) / submit(false)。
  // 注意：EMPTY 初始状态里的 `waiting: false` 是声明不是迁移，必须排除，
  // 否则统计永远差 1（这就是本断言第一版误报的原因）。
  const transitions = (storeSrc.match(/this\.update\(\{[^}]*waiting:\s*(true|false)/g) || []);
  assert(`只有 readLine×2 + submit 三处迁移 waiting，实际 ${transitions.length} 处`, transitions.length === 3);
  assert('EMPTY 初始状态里 waiting = false', /const EMPTY: TuiState = \{[\s\S]*?waiting: false/.test(storeSrc));
}

// ---- 4. 端到端：用 TuiStore 模拟「卡死后是否还能输入」 ----
console.log('\n=== TuiStore 状态机端到端 ===\n');
{
  const { TuiStore } = await import('../dist/cli/tui/store.js');
  const store = new TuiStore();

  // 初始：未就绪，不能输入
  assert('初始 waiting = false（还没 readLine）', store.getSnapshot().waiting === false);

  // 模拟主循环进入 readLine
  const p = store.readLine();
  assert('readLine 后 waiting = true（可以输入）', store.getSnapshot().waiting === true);

  // 打字
  store.insert('h');
  store.insert('i');
  assert('可以输入字符', store.getSnapshot().input === 'hi');

  // 提交 → waiting false（相当于 runSession 期间）
  store.submit();
  await p;
  assert('submit 后 waiting = false（agent 运行中）', store.getSnapshot().waiting === false);

  // 关键：模拟「这一轮抛异常但主循环继续」→ 再次 readLine
  const p2 = store.readLine();
  assert('异常后再次 readLine → waiting 恢复 true（这是修复的关键）', store.getSnapshot().waiting === true);
  store.insert('x');
  assert('恢复后能正常输入', store.getSnapshot().input === 'x');
  store.submit();
  await p2;
}

// ---- 5. 反证：不回到 readLine 就是死局 ----
// 注意语义已变：waiting=false 时 insert 不再被忽略（运行中可输入 → 入队），
// 但**主循环必须回到 readLine** 才能把队列消费掉。所以反证改为：
// 不 readLine → 队列永远排不出去（用户看到「打了字但永远不执行」）。
console.log('\n=== 反证：不回到 readLine 队列永远排不出去 ===\n');
{
  const { TuiStore } = await import('../dist/cli/tui/store.js');
  const store = new TuiStore();
  const p = store.readLine();
  store.insert('a');
  store.submit();
  await p;

  // 主循环已逃出（不再调 readLine）——这正是原 bug 的状态
  store.insert('b');
  store.submit();
  const after = store.getSnapshot();
  assert('运行中打字可以进入输入框（不再被丢弃）', after.input === '');
  assert('运行中提交进入队列（不丢字）', after.queue.length === 1 && after.queue[0] === 'b');

  // 只有 readLine 能消费队列
  const p2 = store.readLine();
  assert('readLine 立刻消费队首（无需用户再按回车）', store.getSnapshot().queue.length === 0);
  assert('队首内容原样返回给主循环', (await p2) === 'b');
}

// ---- 6. submit 渲染抛异常时，readLine 的 Promise 仍必须 resolve ----
// 否则主循环永久挂起在 await cli.readLine() 上，症状与「逃出 while」完全一致。
console.log('\n=== submit 抗渲染异常 ===\n');
{
  const { TuiStore } = await import('../dist/cli/tui/store.js');
  const store = new TuiStore();
  const p = store.readLine();
  store.insert('hello');

  // 注入一个会抛异常的监听器（模拟 appendBlock/update 渲染失败）。
  // 注意 subscribe 在 readLine/insert 之后，所以 submit 内部第一次 update 就是 call 1。
  let calls = 0;
  store.subscribe(() => { calls++; if (calls === 1) throw new Error('render boom'); });

  let submitThrew = false;
  try { store.submit(); } catch { submitThrew = true; }

  let resolved = null;
  const timer = new Promise(r => setTimeout(() => r('TIMEOUT'), 300));
  resolved = await Promise.race([p, timer]);
  assert('渲染抛异常时 readLine 仍被 resolve（不挂死）', resolved === 'hello');
  assert('submit 的异常没有被吞掉（向上传播）', submitThrew);
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
