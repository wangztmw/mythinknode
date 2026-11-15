// 工具参数容错解析回归测试 —— 复现
//   LLM call failed: Unexpected token ''', ..."ywords": ['network-e"... is not valid JSON
//
// 根因：模型生成的 tool_calls[].function.arguments 不是合法 JSON（单引号/尾逗号/裸 key/
// 围栏/注释），openai.ts 里裸 JSON.parse 抛 SyntaxError → query_loop 打成 crashed。
//
// 用法: npm run build && node Plan/cli-test/test-tool-args.mjs

import { parseToolArgs, repairJsonText, extractBalanced } from '../dist/llm/toolargs.js';
import { openaiProvider } from '../dist/llm/openai.js';

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }
function eq(name, actual, expected) { assert(`${name} → ${JSON.stringify(actual)}`, JSON.stringify(actual) === JSON.stringify(expected)); }

console.log('\n=== parseToolArgs ===\n');

// 0. 正常 JSON
eq('合法 JSON 原样通过', parseToolArgs('{"a":1}'), { ok: true, value: { a: 1 } });

// 1. 现场报错：单引号数组 + 双引号 key
{
  const raw = `{"action":"tag","title":"x","keywords":['network-engineering','dns']}`;
  const r = parseToolArgs(raw);
  assert('单引号数组被修复', r.ok);
  eq('单引号数组的值', r.ok && r.value, { action: 'tag', title: 'x', keywords: ['network-engineering', 'dns'] });
}

// 2. 全单引号（Python 风格）
{
  const raw = `{'action':'tag','title':'it\\'s fine','keywords':['a','b']}`;
  const r = parseToolArgs(raw);
  assert('Python 风格单引号全修', r.ok);
  eq('转义单引号 \\\' 还原', r.ok && r.value.title, "it's fine");
  eq('keywords', r.ok && r.value.keywords, ['a', 'b']);
}

// 3. 单引号字符串里含双引号
{
  const raw = `{'note':'he said "hi" loudly'}`;
  const r = parseToolArgs(raw);
  eq('单引号串内双引号被转义', r.ok && r.value, { note: 'he said "hi" loudly' });
}

// 4. 尾逗号
{
  const r = parseToolArgs(`{"a":1,"b":[1,2,],}`);
  eq('尾逗号被去掉', r.ok && r.value, { a: 1, b: [1, 2] });
}

// 5. 裸 key / 裸值（JS 对象字面量风格）
{
  const r = parseToolArgs(`{action: 'tag', keywords: [cdp, chrome], depth: 3, ok: true}`);
  eq('裸 key / 裸字符串值补引号', r.ok && r.value, { action: 'tag', keywords: ['cdp', 'chrome'], depth: 3, ok: true });
}

// 6. 围栏 + 前后夹说明文字
{
  const raw = 'Here is the call:\n```json\n{"a":1}\n```\nDone.';
  eq('剥围栏 + 摘平衡块', parseToolArgs(raw), { ok: true, value: { a: 1 } });
}

// 7. 注释
{
  const r = parseToolArgs(`{"a":1, // trailing\n"b":2 /* block */}`);
  eq('注释被去掉', r.ok && r.value, { a: 1, b: 2 });
}

// 8. 字符串里的裸换行（模型常犯）
{
  const r = parseToolArgs('{"note":"line1\nline2"}');
  eq('裸换行被转义', r.ok && r.value, { note: 'line1\nline2' });
}

// 9. 救不回来时：不抛，返回 ok:false
{
  let threw = false, r;
  try { r = parseToolArgs('{"a": "truncated'); } catch { threw = true; }
  assert('截断 JSON 不抛异常', !threw);
  assert('截断 JSON 返回 ok:false', r && r.ok === false);
  assert('失败时带 error 信息', r && r.ok === false && typeof r.error === 'string' && r.error.length > 0);
}

// 10. 空串 / null → {}
eq('空串 → {}', parseToolArgs(''), { ok: true, value: {} });
eq('空白 → {}', parseToolArgs('   '), { ok: true, value: {} });
eq('null → {}', parseToolArgs(null), { ok: true, value: {} });
eq('已是对象 → 透传', parseToolArgs({ a: 1 }), { ok: true, value: { a: 1 } });

// 11. 工具函数本身
eq('extractBalanced 取第一个平衡块', extractBalanced('x {"a":{"b":1}} y'), '{"a":{"b":1}}');
assert('repairJsonText 幂等（合法 JSON 不变）', repairJsonText('{"a":[1,2]}') === '{"a":[1,2]}');

console.log('\n=== openaiProvider 出口不崩 ===\n');

// 模拟 API 返回「arguments 是单引号」的 tool_call
let capturedMessages = null;
function mockFetch(toolArgsRaw) {
  globalThis.fetch = async (_url, init) => {
    capturedMessages = JSON.parse(init.body).messages;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Remember', arguments: toolArgsRaw } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
  };
}

// 可修复：单引号 → 正常拿到 input
{
  mockFetch(`{"action":"tag","keywords":['a','b']}`);
  const res = await openaiProvider.call('sys', [{ role: 'user', content: 'hi' }], 'k', 'm', [], 'https://x.test');
  const tu = res.content.find(b => b.type === 'tool_use');
  assert('可修复的单引号参数被救回', !!tu && !tu._argError);
  eq('救回后的 input', tu && tu.input, { action: 'tag', keywords: ['a', 'b'] });
  assert('stop_reason = tool_use', res.stop_reason === 'tool_use');
}

// 不可修复：不抛异常，挂 _argError + _rawArgs
{
  mockFetch(`{"action": "tag", "note": "truncated`);
  let threw = false, res;
  try { res = await openaiProvider.call('sys', [{ role: 'user', content: 'hi' }], 'k', 'm', [], 'https://x.test'); }
  catch { threw = true; }
  assert('坏参数不让 call() 抛异常（原 bug 在此崩）', !threw);
  const tu = res && res.content.find(b => b.type === 'tool_use');
  assert('坏参数挂 _argError', !!tu && typeof tu._argError === 'string');
  assert('坏参数挂 _rawArgs（回灌给模型看）', !!tu && typeof tu._rawArgs === 'string' && tu._rawArgs.length > 0);
  eq('坏参数 input 兜底为 {}', tu && tu.input, {});
}

// 关键：下一轮请求体里 assistant.tool_calls.arguments 必须是合法 JSON
// （否则 DeepSeek 会回 400，把自愈路径堵死）
{
  mockFetch(`{"action": "tag", "note": "truncated`);
  const history = [{ role: 'user', content: 'hi' }];
  const res = await openaiProvider.call('sys', history, 'k', 'm', [], 'https://x.test');
  history.push({ role: 'assistant', content: res.content });
  history.push({ role: 'tool', tool_call_id: 'c1', content: 'Error: bad json, re-emit' });
  history.push({ role: 'user', content: 'retry' });
  mockFetch('{"action":"tag"}');
  await openaiProvider.call('sys', history, 'k', 'm', [], 'https://x.test');

  const assistantWithCalls = capturedMessages.find(m => m.role === 'assistant' && m.tool_calls);
  const argsStr = assistantWithCalls?.tool_calls?.[0]?.function?.arguments;
  let argsValid = true;
  try { JSON.parse(argsStr); } catch { argsValid = false; }
  assert('回灌历史里的 arguments 是合法 JSON（不会引发 400）', argsValid);
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
