// agentLoop 软预算 / 护栏回归测试
//   1. 软预算续期：撞 maxRounds 后模型「继续调工具」= 自己决定续期，不判 max_rounds
//   2. 软预算收尾：撞 maxRounds 后模型「只出文字」= 自己决定结束，判 success
//   3. 续期满：达到 maxExtensions 后仍继续 → max_rounds
//   4. 无进展提醒：连续相同 工具+参数+输出 达 noProgressWarn → 注入 [NO PROGRESS]
//   5. 无进展强停：达 noProgressStop → blocked
//   6. 输出在变（轮询等后台任务）→ 不算卡死
//   7. 墙钟 / token 护栏
//   8. killed / blocked / crashed 既有行为不被破坏
//
// 用法: npm run build && node Plan/cli-test/test-loop-budget.mjs

import { agentLoop } from '../dist/query_loop.js';

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

/** 造 engine：plan(roundIndex) 决定每轮返回什么；outputs 是 工具名 → 输出函数 */
function makeEngine(plan, outputs = {}) {
  let n = 0;
  const seen = [];
  const engine = {
    systemPrompt: 'sys',
    toolContext: {},
    emit: () => {},
    mergeToolCalls: (c) => c,
    toolMap: new Map(),
    llm: {
      formatToolResult: (id, out) => ({ role: 'tool', tool_call_id: id, content: out }),
      async chat(messages) {
        seen.push(JSON.parse(JSON.stringify(messages)));
        const step = plan(n);
        n++;
        return step;
      },
    },
    get seen() { return seen; },
  };
  for (const [name, fn] of Object.entries(outputs)) {
    engine.toolMap.set(name, {
      call: async (input) => ({ data: await fn(input) }),
      getToolUseSummary: () => name,
    });
  }
  return engine;
}

const toolTurn = (name, input) => ({
  content: [{ type: 'tool_use', id: 'c' + Math.random().toString(36).slice(2, 6), name, input }],
  stop_reason: 'tool_use',
});
const textTurn = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });

/** 每次运行都用全新的 messages 数组，避免跨用例污染 */
function run(engine, opts) {
  return agentLoop(engine, { messages: [{ role: 'user', content: 'go' }], silent: true, ...opts });
}

/** 最后一轮请求体里注入了多少条以 prefix 开头的消息（= 真正注入过的次数） */
function injected(engine, prefix) {
  const last = engine.seen[engine.seen.length - 1] || [];
  return last.filter(m => typeof m.content === 'string' && m.content.startsWith(prefix));
}

console.log('\n=== 软预算续期 ===\n');

// 模型永远调工具 → 撞 maxRounds 后应被允许续期，直到续满才 max_rounds
{
  const engine = makeEngine((n) => toolTurn('Bash', { seq: n }), { Bash: (i) => `out-${i.seq}` });
  const res = await run(engine, { maxRounds: 3, maxExtensions: 2, wallClockMs: 0, noProgressStop: 99 });
  assert('续满后状态为 max_rounds', res.status === 'max_rounds');
  assert(`总轮数 = 3 * (1 + 2) = 9，实际 ${res.roundCount}`, res.roundCount === 9);
  assert(`extensions = 2，实际 ${res.extensions}`, res.extensions === 2);
  const budgetMsgs = injected(engine, '[BUDGET]');
  assert(`注入了 2 条 [BUDGET] 检查点，实际 ${budgetMsgs.length}`, budgetMsgs.length === 2);
  assert('[BUDGET] 要求模型自行判断收尾或继续',
    budgetMsgs[0].content.includes('reply with a final text answer and NO tool calls'));
  assert('[BUDGET] 提示续期次数与硬上限',
    budgetMsgs[0].content.includes('hard stop at 9 rounds') && budgetMsgs[0].content.includes('2 continuation(s) left'));
  assert('[BUDGET] 第二次检查点剩 1 次续期', budgetMsgs[1].content.includes('1 continuation(s) left'));
}

// 撞 maxRounds 后模型自己收尾 → success
{
  const engine = makeEngine((n) => n < 3 ? toolTurn('Bash', { seq: n }) : textTurn('done'), { Bash: (i) => `out-${i.seq}` });
  const res = await run(engine, { maxRounds: 3, maxExtensions: 3, wallClockMs: 0 });
  assert('模型自己收尾 → success', res.status === 'success');
  assert('收尾文本正确', res.text === 'done');
  assert(`extensions = 1（用过一次检查点），实际 ${res.extensions}`, res.extensions === 1);
}

// 不撞预算的普通任务：不应出现 [BUDGET]
{
  const engine = makeEngine((n) => n === 0 ? toolTurn('Bash', {}) : textTurn('ok'), { Bash: () => 'x' });
  const res = await run(engine, { maxRounds: 25, wallClockMs: 0 });
  assert('普通任务 success', res.status === 'success');
  assert('extensions = 0', res.extensions === 0);
  assert('普通任务无 [BUDGET] 注入', injected(engine, '[BUDGET]').length === 0);
}

console.log('\n=== 无进展护栏 ===\n');

// 完全相同的工具调用 + 相同输出 → 强停
{
  const engine = makeEngine(() => toolTurn('Bash', { cmd: 'ls' }), { Bash: () => 'same output' });
  const res = await run(engine, { maxRounds: 50, wallClockMs: 0, noProgressWarn: 3, noProgressStop: 6 });
  assert('相同调用+相同输出 → blocked', res.status === 'blocked');
  assert(`blockedReason 提到 no progress，实际: ${res.blockedReason}`, /no progress/.test(res.blockedReason || ''));
  assert(`在第 6 轮停（roundCount=${res.roundCount}）`, res.roundCount === 6);
  const warnMsgs = injected(engine, '[NO PROGRESS]');
  assert(`强停前注入过 1 条 [NO PROGRESS] 提醒，实际 ${warnMsgs.length}`, warnMsgs.length === 1);
  assert('[NO PROGRESS] 要求换策略', warnMsgs[0].content.includes('Change your approach'));
}

// 参数不同（有进展）→ 不应被判卡死
{
  const engine = makeEngine((n) => n < 10 ? toolTurn('Bash', { seq: n }) : textTurn('done'), { Bash: (i) => `out-${i.seq}` });
  const res = await run(engine, { maxRounds: 50, wallClockMs: 0, noProgressStop: 6 });
  assert('参数每轮都变 → 不误判卡死', res.status === 'success');
}

// 轮询场景：参数相同但输出在变 → 不应被判卡死
{
  let k = 0;
  const engine = makeEngine((n) => n < 10 ? toolTurn('Agent', { action: 'wait_any' }) : textTurn('done'), { Agent: () => `running... ${k++}` });
  const res = await run(engine, { maxRounds: 50, wallClockMs: 0, noProgressWarn: 3, noProgressStop: 6 });
  assert('轮询（参数同/输出变）不误判卡死', res.status === 'success');
}

console.log('\n=== 成本护栏 ===\n');

// 墙钟
{
  const engine = makeEngine(() => toolTurn('Slow', {}), { Slow: () => 'x' });
  engine.toolMap.set('Slow', {
    call: async () => { await new Promise(r => setTimeout(r, 60)); return { data: 'x' }; },
    getToolUseSummary: () => 'Slow',
  });
  const res = await run(engine, { maxRounds: 100, wallClockMs: 150, noProgressStop: 99 });
  assert('墙钟到期 → blocked', res.status === 'blocked');
  assert(`blockedReason 提到 wall-clock，实际: ${res.blockedReason}`, /wall-clock/.test(res.blockedReason || ''));
}

// token 预算
{
  const engine = makeEngine(() => ({
    content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { seq: Math.random() } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 100 },
  }), { Bash: () => 'x' });
  const res = await run(engine, { maxRounds: 100, wallClockMs: 0, tokenBudget: 500, noProgressStop: 99 });
  assert('token 超预算 → blocked', res.status === 'blocked');
  assert(`blockedReason 提到 token，实际: ${res.blockedReason}`, /token/.test(res.blockedReason || ''));
}

console.log('\n=== 既有信号不被破坏 ===\n');

{
  const engine = makeEngine(() => toolTurn('Bash', {}), { Bash: () => 'x' });
  const res = await run(engine, { maxRounds: 10, wallClockMs: 0, preRoundCheck: () => 'BLOCKED: user denied' });
  assert('BLOCKED 信号仍生效', res.status === 'blocked');
  assert('blockedReason 正确', res.blockedReason === 'user denied');
}
{
  const engine = makeEngine(() => toolTurn('Bash', {}), { Bash: () => 'x' });
  const res = await run(engine, { maxRounds: 10, wallClockMs: 0, preRoundCheck: () => '(killed)' });
  assert('killed 信号仍生效', res.status === 'killed');
}
{
  const engine = makeEngine(() => { throw new Error('boom'); });
  const res = await run(engine, { maxRounds: 10, wallClockMs: 0 });
  assert('LLM 报错 → crashed', res.status === 'crashed');
  assert('crashed 文本保留 LLM call failed 前缀', res.text.startsWith('LLM call failed:'));
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
