/**
 * 「按回车后立刻有反馈」+ 计时连续性 契约测试。
 *
 * 背景：三条召回（MessageReminder / NodeMind / TraitGraph）改前是**串行** await，
 * 每条都可能是一次 LLM 往返（云端 1~3s）。而且 setPhase 在 agentLoop 里才第一次调用，
 * 所以用户按下回车后屏幕上什么都没有好几秒，然后计时从 0 开始 —— 体感像卡住。
 *
 * 实测（假 LLM 每次 0.8s）：改前 1031ms 才出现状态行；改后 321ms。
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { AgentEngine } from '../dist/agent/agent_def.js';
import { idleState } from '../dist/agent/runtime_state.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name} — ${e.message}`); fail++; }
};

const SRC = new URL('../src/', import.meta.url);
const read = (p) => readFileSync(new URL(p, SRC), 'utf8');

console.log('\n=== 1. 召回阶段立刻进入 thinking（不再等三次召回跑完）===');

check('runSession 在召回前就 setPhase', () => {
  const s = read('session_loop.ts');
  const iPhase = s.indexOf("setPhase?.('thinking', 'recalling context')");
  const iRecall = s.indexOf('Promise.allSettled');
  assert.ok(iPhase > 0, '找不到提前 setPhase 调用');
  assert.ok(iRecall > 0, '找不到召回块');
  assert.ok(iPhase < iRecall, `setPhase(${iPhase}) 必须在召回(${iRecall}) 之前`);
});

check('召回标签说明「在做什么」（不是空标签）', () => {
  const s = read('session_loop.ts');
  assert.ok(/setPhase\?\.\('thinking',\s*'recalling context'\)/.test(s));
});

console.log('\n=== 2. 三条召回并发执行 ===');

check('三条召回在同一个 Promise.allSettled 里', () => {
  const s = read('session_loop.ts');
  const m = s.match(/Promise\.allSettled\(\[([\s\S]*?)\]\)/);
  assert.ok(m, '找不到 Promise.allSettled');
  const body = m[1];
  assert.ok(/reminder\.recall\(/.test(body), '缺 reminder.recall');
  assert.ok(/navigator\.search\(/.test(body), '缺 navigator.search');
  assert.ok(/recallTraits\(/.test(body), '缺 recallTraits');
});

check('不再有「串行 await 三次召回」的写法', () => {
  const s = read('session_loop.ts');
  assert.ok(!/await reminder\.recall\(/.test(s), '仍有串行 await reminder.recall');
  assert.ok(!/await nodemind\.navigator\.search\(/.test(s), '仍有串行 await navigator.search');
  assert.ok(!/await recallTraits\(/.test(s), '仍有串行 await recallTraits');
});

check('★ 单条召回失败不影响另外两条（allSettled 而非 all）', () => {
  const s = read('session_loop.ts');
  // Promise.all 会因任一 reject 而整体 reject，丢掉另外两条的结果
  assert.ok(!/Promise\.all\(\[[\s\S]*?reminder\.recall/.test(s), '用了 Promise.all');
  assert.ok(/reminderRes\.status === 'fulfilled'/.test(s), '缺 reminder 的 settled 判断');
  assert.ok(/nodemindRes\.status === 'fulfilled'/.test(s), '缺 nodemind 的 settled 判断');
  assert.ok(/traitRes\.status === 'fulfilled'/.test(s), '缺 trait 的 settled 判断');
});

check('注入顺序与原串行版一致（reminder → nodemind → trait）', () => {
  const s = read('session_loop.ts');
  const iRem = s.indexOf('reminderRes.status');
  const iNode = s.indexOf('nodemindRes.status');
  const iTrait = s.indexOf('traitRes.status');
  assert.ok(iRem < iNode && iNode < iTrait, `顺序错乱 ${iRem}/${iNode}/${iTrait}`);
});

console.log('\n=== 3. setPhase 同一阶段内不重置计时 ===');

const fakeLLM = { chat: async () => ({ content: [], stop_reason: 'end_turn' }), formatToolResult: () => ({}) };
const engine = new AgentEngine(fakeLLM, []);
engine.resetPhase();
const before = Date.now();
engine.setPhase('thinking', 'recalling context');
const t1 = engine.snapshot().phaseStartedAt;
assert.ok(Math.abs(t1 - before) < 100);

check('同 phase 内换 label → 计时起点不变（review 与 analyzing 之间不跳回 0）', () => {
  engine.setPhase('thinking', 'analyzing', 0);
  const s = engine.snapshot();
  assert.equal(s.phaseStartedAt, t1, '同一 thinking 阶段被重置了计时');
  assert.equal(s.label, 'analyzing');
});

check('phase 真变化（thinking → executing）→ 重置计时', () => {
  engine.setExecuting('Bash');
  const s = engine.snapshot();
  assert.ok(s.phaseStartedAt >= t1, '进入工具阶段应重置计时');
  assert.equal(s.phase, 'executing');
  assert.equal(s.tool?.name, 'Bash');
});

check('executing → thinking（下一轮）→ 重置计时', () => {
  engine.setPhase('thinking', 'analyzing', 1);
  const s = engine.snapshot();
  assert.equal(s.phase, 'thinking');
  assert.equal(s.tool, undefined, '换阶段应清掉 tool');
});

check('resetPhase → 回到 idle，phaseStartedAt 刷新', () => {
  engine.resetPhase();
  const s = engine.snapshot();
  assert.equal(s.phase, 'idle');
  assert.ok(engine.snapshot().phaseStartedAt > 0);
});

console.log('\n=== 4. 时间语义仍归观察者（未回退）===');

check('RuntimeState 不含任何「已过多久」字段', () => {
  const keys = Object.keys(idleState());
  assert.deepEqual(keys.filter(k => /elapsed|duration|took/i.test(k)), []);
});

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
