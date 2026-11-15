// 中断当前行动 —— 单元测试
// 用法: node Plan/cli-test/test-interrupt.mjs（需先 npm run build）
//
// 覆盖三层：
//   1. agent/interrupt.ts     中断总线（单飞 / 幂等 / 状态不跨轮泄漏）
//   2. session/session_integrity.ts  悬空 tool_use 修复（会话完整性的核心）
//   3. query_loop / retry     中断 → killed 而非 crashed；用户中断不重试
import { readFileSync } from 'node:fs';

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const SRC = new URL('../src/', import.meta.url).pathname;
const D = new URL('../dist/', import.meta.url).pathname;
const code = (p) => readFileSync(SRC + p, 'utf8')
  .split('\n')
  .filter(l => { const t = l.trim(); return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); })
  .join('\n');

const {
  beginRun, endRun, abortCurrentRun, hasActiveRun, currentSignal,
  UserAbortError, __resetInterruptForTest,
} = await import(D + 'agent/interrupt.js');
const { repairDanglingToolUses, interruptNotice } = await import(D + 'session/session_integrity.js');
const { isRetryable, fetchWithRetry } = await import(D + 'llm/retry.js');

// ============================================================
console.log('\n=== 1. 中断总线：单飞与幂等 ===\n');
// ============================================================
{
  __resetInterruptForTest();
  assert('初始无活跃 run', hasActiveRun() === false);
  assert('初始无 signal', currentSignal() === undefined);
  assert('空闲时 abortCurrentRun 返回 false', abortCurrentRun() === false);

  const r1 = beginRun();
  assert('beginRun 后 hasActiveRun=true', hasActiveRun() === true);
  assert('signal 初始未 abort', r1.signal.aborted === false);
  assert('currentSignal 指向当前 run', currentSignal() === r1.signal);

  assert('abortCurrentRun 返回 true（有活跃 run）', abortCurrentRun() === true);
  assert('abort 后 signal.aborted=true', r1.signal.aborted === true);
  assert('重复 abort 幂等（仍 true）', abortCurrentRun() === true);
  assert('signal 仍 aborted', r1.signal.aborted === true);

  endRun(r1);
  assert('endRun 后无活跃 run', hasActiveRun() === false);

  // ★ 关键：新一轮必须是干净的 signal（不能继承上一轮的 aborted 状态）
  const r2 = beginRun();
  assert('新一轮 signal 未 abort（状态不跨轮泄漏）', r2.signal.aborted === false,
    `aborted=${r2.signal.aborted}`);
  assert('新一轮 signal 与旧的不同对象', r2.signal !== r1.signal);
  endRun(r2);

  // beginRun 防御：上一个 run 没 endRun 就开新的 → 旧的回被 abort
  const r3 = beginRun();
  const r4 = beginRun();
  assert('beginRun 会收掉上一个未结束的 run', r3.signal.aborted === true);
  assert('新 run 仍未 abort', r4.signal.aborted === false);
  endRun(r4);

  // 中断原因可定制
  __resetInterruptForTest();
  const r5 = beginRun();
  abortCurrentRun('用户按了 Esc');
  assert('中断原因可定制', r5.reason === '用户按了 Esc', r5.reason);
  endRun(r5);

  assert('UserAbortError 的 name 正确', new UserAbortError().name === 'UserAbortError');
}

// ============================================================
console.log('\n=== 2. 会话完整性：悬空 tool_use 修复 ===\n');
// ============================================================
// provider 形状：OpenAI 用 {role:'tool', tool_call_id}，Anthropic 用
// {role:'user', content:[{type:'tool_result', tool_use_id}]}
const openaiFmt = (id, out) => ({ role: 'tool', tool_call_id: id, content: out });
const anthropicFmt = (id, out) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] });
{
  // --- 单个悬空 ---
  let msgs = [
    { role: 'user', content: '帮我看看' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } }] },
    // 工具结果缺失（被打断）
  ];
  let rep = repairDanglingToolUses(msgs, { formatToolResult: openaiFmt });
  assert('单个悬空 → 补 1 条', rep.patched === 1, String(rep.patched));
  assert('补的是 tu_1', rep.ids[0] === 'tu_1', JSON.stringify(rep.ids));
  assert('messages 长度 3', msgs.length === 3);
  assert('补的是 role:tool 且 id 正确',
    msgs[2].role === 'tool' && msgs[2].tool_call_id === 'tu_1', JSON.stringify(msgs[2]));

  // --- 多个悬空（并行工具）---
  msgs = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu_a', name: 'Read', input: {} },
      { type: 'tool_use', id: 'tu_b', name: 'Bash', input: {} },
      { type: 'tool_use', id: 'tu_c', name: 'Grep', input: {} },
    ] },
    // 只有 tu_a 有结果
    { role: 'tool', tool_call_id: 'tu_a', content: 'ok' },
  ];
  rep = repairDanglingToolUses(msgs, { formatToolResult: openaiFmt });
  assert('3 个工具只回 1 个 → 补 2 条', rep.patched === 2, String(rep.patched));
  assert('补的是 tu_b / tu_c', rep.ids.join(',') === 'tu_b,tu_c', JSON.stringify(rep.ids));
  assert('已有的 tu_a 结果保留', msgs.some(m => m.tool_call_id === 'tu_a'));
  assert('总长度 5', msgs.length === 5, String(msgs.length));

  // --- 已配对 → 不动 ---
  msgs = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Read', input: {} }] },
    { role: 'tool', tool_call_id: 'x1', content: '结果' },
  ];
  const before = JSON.stringify(msgs);
  rep = repairDanglingToolUses(msgs, { formatToolResult: openaiFmt });
  assert('已配对 → 不补任何东西', rep.patched === 0);
  assert('已配对 → messages 未被改动', JSON.stringify(msgs) === before);

  // --- 尾部是纯文本 assistant → 不动 ---
  msgs = [
    { role: 'assistant', content: [{ type: 'text', text: '完成了' }] },
  ];
  rep = repairDanglingToolUses(msgs, { formatToolResult: openaiFmt });
  assert('无 tool_use 的 assistant → 不补', rep.patched === 0);

  // --- 空 messages ---
  rep = repairDanglingToolUses([], { formatToolResult: openaiFmt });
  assert('空 messages → 不补', rep.patched === 0);

  // --- Anthropic 形状 ---
  msgs = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Read', input: {} }] },
  ];
  rep = repairDanglingToolUses(msgs, { formatToolResult: anthropicFmt });
  assert('Anthropic 形状 → 补 1 条', rep.patched === 1);
  assert('Anthropic 用 user + tool_result 块',
    msgs[1].role === 'user'
    && Array.isArray(msgs[1].content)
    && msgs[1].content[0].type === 'tool_result'
    && msgs[1].content[0].tool_use_id === 'a1', JSON.stringify(msgs[1]));

  // --- 多个工具已全配对（Anthropic 一次 carrier 带多个块）---
  msgs = [
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'm1', name: 'A', input: {} },
      { type: 'tool_use', id: 'm2', name: 'B', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'm1', content: 'r1' },
      { type: 'tool_result', tool_use_id: 'm2', content: 'r2' },
    ] },
  ];
  rep = repairDanglingToolUses(msgs, { formatToolResult: anthropicFmt });
  assert('Anthropic 多结果已全配对 → 不补', rep.patched === 0);

  // --- 中途悬空（后面还有正常对话）---
  msgs = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'z1', name: 'Read', input: {} }] },
    { role: 'user', content: '算了别读了' },          // 用户插话，没给工具结果
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
  ];
  rep = repairDanglingToolUses(msgs, { formatToolResult: openaiFmt });
  assert('工具后面紧跟 user 文本 → 仍判定为悬空并补齐', rep.patched === 1, String(rep.patched));
  assert('补齐位置在 user 文本之前', msgs[1].role === 'tool', JSON.stringify(msgs[1]));

  // --- 填充文本可定制 ---
  msgs = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'X', input: {} }] }];
  repairDanglingToolUses(msgs, { formatToolResult: openaiFmt, content: 'CUSTOM-FILL' });
  assert('填充文本可定制', msgs[1].content === 'CUSTOM-FILL', msgs[1].content);
}

// ============================================================
console.log('\n=== 3. 中断说明文本 ===\n');
// ============================================================
{
  const n = interruptNotice(3, 2, '用户按了 Esc');
  assert('说明里包含中断原因', n.includes('用户按了 Esc'), n);
  assert('说明里包含轮次', n.includes('第 3 轮'), n);
  assert('说明里包含工具数量', n.includes('2 个工具调用'), n);
  assert('提示不要自动重试', n.includes('不要自动重试'), n);
  assert('提示已完成的部分', n.includes('已完成的部分'), n);

  const n0 = interruptNotice(1, 0);
  assert('0 个工具时不提工具数量', !n0.includes('个工具调用'), n0);
}

// ============================================================
console.log('\n=== 4. retry：用户中断不重试 ===\n');
// ============================================================
{
  const uae = new UserAbortError();
  assert('UserAbortError → 不重试', isRetryable(uae) === false);
  const ab = new Error('aborted by user');
  ab.name = 'AbortError';
  assert('AbortError + user message → 不重试', isRetryable(ab) === false);
  // 普通超时仍要重试（不能被上面的规则误伤）
  const timeout = new Error('request timeout');
  assert('普通 timeout → 仍重试', isRetryable(timeout) === true);
  const abortTimeout = new Error('Fetch aborted: total timeout (600s) exceeded');
  assert('总超时（message 含 aborted）→ 仍重试', isRetryable(abortTimeout) === true);

  // 端到端：外部 signal 已 abort → 立刻抛，且 fetch 不被调用
  let fetchCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('should not be called'); };
  const ctrl = new AbortController();
  ctrl.abort();
  let threw = null;
  try {
    await fetchWithRetry('http://127.0.0.1:1/x', { method: 'POST' }, 10, 1000, 5000, ctrl.signal);
  } catch (e) { threw = e; }
  globalThis.fetch = origFetch;
  assert('signal 已 abort → 抛错', !!threw, String(threw));
  assert('抛的是 UserAbortError', threw?.name === 'UserAbortError', threw?.name);
  assert('fetch 一次都没被调用', fetchCalls === 0, `${fetchCalls} 次`);

  // 外部 signal 中途 abort → 不重试
  fetchCalls = 0;
  globalThis.fetch = async (_url, init) => {
    fetchCalls++;
    // 模拟慢请求：等到 signal abort
    await new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    throw new Error('unreachable');
  };
  const ctrl2 = new AbortController();
  const p = fetchWithRetry('http://127.0.0.1:1/y', { method: 'POST' }, 10, 1000, 5000, ctrl2.signal);
  setTimeout(() => ctrl2.abort(), 50);
  const t0 = Date.now();
  let threw2 = null;
  try { await p; } catch (e) { threw2 = e; }
  const elapsed = Date.now() - t0;
  globalThis.fetch = origFetch;
  assert('中途 abort → 抛 UserAbortError', threw2?.name === 'UserAbortError', threw2?.name);
  assert('中途 abort → 不重试（fetch 只 1 次）', fetchCalls === 1, `${fetchCalls} 次`);
  assert('中途 abort → 立刻返回（<2s，没有指数退避）', elapsed < 2000, `${elapsed}ms`);
}

// ============================================================
console.log('\n=== 5. 结构：接线正确 ===\n');
// ============================================================
{
  const ql = code('query_loop.ts');
  assert('agentLoop 接受 signal', /signal\?:\s*AbortSignal/.test(ql));
  assert('用局部别名避开 preRoundCheck 的 signal 遮蔽', /const abortSignal = params\.signal/.test(ql));
  assert('循环顶部检查中断', /if \(abortSignal\?\.aborted\)/.test(ql));
  assert('LLM 调用传 signal', /llm\.chat\([^)]*abortSignal\)/.test(ql) || /chat\(messages[^;]*abortSignal/.test(ql));
  assert('工具执行传 signal', /serialTools, silent, abortSignal\)/.test(ql));
  assert('abort 映射为 killed 而非 crashed', /isUserAbort/.test(ql) && /return done\('killed'/.test(ql));
  assert('中断前先 pushResults（保证 tool_result 配对）',
    ql.indexOf('pushResults(messages, engine, toolResults)') < ql.indexOf('exec.interrupted'));

  const sl = code('session_loop.ts');
  assert('session_loop 用 beginRun', /beginRun\(\)/.test(sl));
  assert('session_loop 传 signal 给 agentLoop', /signal: runHandle\.signal/.test(sl));
  assert('中断后修复悬空 tool_use', /repairDanglingToolUses\(/.test(sl));
  assert('中断后注入说明', /interruptNotice\(/.test(sl));
  assert('中断后落盘', /session\.save\(\)/.test(sl));
  // ⚠️ 注意 code() 会剥注释：不能用 'Post-loop guard' 这种只在注释里出现的字符串做锚点，
  // 否则 indexOf 返回 -1，断言恒为 false（这里踩过一次）。
  assert('中断后跳过后台 Agent 等待（在 runningAfter 之前提前 return）',
    sl.indexOf('if (interrupted)') !== -1
    && sl.indexOf('if (interrupted)') < sl.indexOf('const runningAfter'), '锚点缺失');
  assert('所有出口都 endRun', (sl.match(/endRun\(runHandle\)/g) ?? []).length >= 2,
    `${(sl.match(/endRun\(runHandle\)/g) ?? []).length} 处`);

  const app = code('cli/tui/SessionApp.tsx');
  assert('SessionApp 处理 Esc', /key\.escape/.test(app));
  assert('Ctrl+C 先尝试中断再退出', /store\.requestInterrupt\(\)/.test(app));
  // 2026-11-14：输入闸门 `if (!state.waiting) return;` 已被拆除
  // （运行中也要能输入 → 入队，见 Plan/20261114-1134-tui-command-queue）。
  // 所以这里改成断言「中断分支排在普通按键处理之前」，这才是真正要保的不变量。
  assert('Esc 分支在普通按键处理之前',
    app.indexOf('key.escape') !== -1
    && app.indexOf('key.escape') < app.indexOf('if (key.return) store.submit();'));

  const store = code('cli/tui/store.ts');
  assert('store 有 interruptHandler 字段', /interruptHandler/.test(store));
  assert('requestInterrupt 返回布尔', /requestInterrupt\(\): boolean/.test(store));
  assert('没有 handler 时返回 false', /if \(!this\.interruptHandler\) return false/.test(store));

  const ib = code('cli/input/input-buffer.ts');
  assert('classic 输入也走中断（Ctrl+C 不直接退出）', /interruptHandler/.test(ib));
  assert('classic 里 exit 前先试中断',
    ib.indexOf('api.interruptHandler && api.interruptHandler()') < ib.indexOf("ss.emit('\\nBye.\\n')"));

  const main = code('Mythinknode.ts');
  assert('主循环注册中断处理器', /setInterruptHandler\?\.\(/.test(main));
  assert('主循环 finally 清除中断处理器', /setInterruptHandler\?\.\(null\)/.test(main));
  assert('classic 模式接管 SIGINT', /process\.on\('SIGINT'/.test(main));
  assert('classic 模式 finally 移除 SIGINT', /process\.off\('SIGINT'/.test(main));
}

// ============================================================
console.log('\n=== 6. 端到端：abort 后 agentLoop 返回 killed 且消息可继续用 ===\n');
// ============================================================
{
  __resetInterruptForTest();
  const { agentLoop } = await import(D + 'query_loop.js');

  // --- 6a. signal 已 abort → 立刻 killed，零轮 ---
  const ctrl = new AbortController();
  ctrl.abort();
  const fakeEngine = {
    systemPrompt: 'x',
    toolMap: new Map(),
    toolContext: {},
    emit: () => {},
    mergeToolCalls: (c) => c,
    llm: {
      chat: async () => { throw new Error('不该被调用'); },
      formatToolResult: openaiFmt,
    },
  };
  let r = await agentLoop(fakeEngine, { messages: [], maxRounds: 5, signal: ctrl.signal, silent: true });
  assert('signal 已 abort → status=killed', r.status === 'killed', r.status);
  assert('signal 已 abort → 不 crash', r.status !== 'crashed');

  // --- 6b. LLM 调用中抛 UserAbortError → killed 而非 crashed ---
  const ctrl2 = new AbortController();
  const engineAbort = {
    ...fakeEngine,
    llm: {
      chat: async () => {
        ctrl2.abort();
        throw Object.assign(new Error('aborted by user'), { name: 'UserAbortError' });
      },
      formatToolResult: openaiFmt,
    },
  };
  r = await agentLoop(engineAbort, { messages: [], maxRounds: 5, signal: ctrl2.signal, silent: true });
  assert('LLM 抛 UserAbortError → killed', r.status === 'killed', r.status);
  assert('LLM 抛 UserAbortError → 不是 crashed', r.status !== 'crashed');

  // --- 6c. 工具执行中 abort → 立刻返回，不等 30s 超时 ---
  const ctrl3 = new AbortController();
  const slowTool = {
    name: 'Slow',
    call: () => new Promise(res => setTimeout(() => res({ data: 'done' }), 30_000)),
    getToolUseSummary: () => 'slow',
  };
  const engineSlow = {
    ...fakeEngine,
    toolMap: new Map([['Slow', slowTool]]),
    llm: {
      chat: async () => ({
        content: [{ type: 'tool_use', id: 'slow1', name: 'Slow', input: {} }],
        stop_reason: 'tool_use',
      }),
      formatToolResult: openaiFmt,
    },
  };
  const msgs = [];
  const t0 = Date.now();
  const p3 = agentLoop(engineSlow, { messages: msgs, maxRounds: 5, signal: ctrl3.signal, silent: true });
  setTimeout(() => ctrl3.abort(), 100);
  r = await p3;
  const elapsed = Date.now() - t0;
  assert('工具执行中 abort → killed', r.status === 'killed', r.status);
  assert('不会等到 30s 工具超时', elapsed < 5000, `${elapsed}ms`);

  // ★ 最关键：消息里没有悬空 tool_use
  const repair = repairDanglingToolUses(msgs, { formatToolResult: openaiFmt });
  assert('abort 后 tool_use / tool_result 已配对（无悬空）',
    repair.patched === 0, `还有 ${repair.patched} 条悬空`);
  const hasToolUse = msgs.some(m => m.role === 'assistant' && Array.isArray(m.content)
    && m.content.some(b => b.type === 'tool_use'));
  const hasToolResult = msgs.some(m => m.role === 'tool');
  assert('确实有过 tool_use', hasToolUse);
  assert('也确实写入了对应的 tool_result', hasToolResult);
}

console.log(`\n结果: ${PASS} 通过, ${FAIL} 失败\n`);
process.exit(FAIL === 0 ? 0 : 1);
