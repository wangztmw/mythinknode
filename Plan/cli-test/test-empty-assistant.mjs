// 空 assistant 消息回归测试 —— 复现 "Invalid assistant message: content or tool_calls must be set" 400
// 用法: npm run build && node Plan/cli-test/test-empty-assistant.mjs
//
// 根因：DeepSeek 推理模型在工具结果后可能返回「既无 text 也无 tool_calls」的空回合，
// query_loop 把它 push 成 { role:'assistant', content: [] }，下一轮 openai.ts 转成
// { role:'assistant', content:null } 发给 API → 400。
//
// 验证两件事：
//   1. openai.ts 出口：空 assistant 消息被跳过，不出现在请求体里
//   2. 正常 assistant（有 text / 有 tool_calls）不受影响

import { openaiProvider } from '../../dist/llm/openai.js';

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

// 捕获请求体
let capturedMessages = null;
globalThis.fetch = async (_url, init) => {
  capturedMessages = JSON.parse(init.body).messages;
  return {
    ok: true,
    status: 200,
    // fetchWithRetry 现在在重试循环内读 .text()（截断纳入重试），mock 需提供 text
    text: async () => JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  };
};

console.log('\n=== 空 assistant 消息回归 ===\n');

// 场景：工具结果后模型返回空回合，被 push 成 content:[]；后续用户继续
const messages = [
  { role: 'user', content: '你来帮我做吧。' },
  { role: 'assistant', content: [{ type: 'text', text: '好，我先看环境。' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } }] },
  { role: 'tool', tool_call_id: 't1', content: '=== result ===' },
  { role: 'assistant', content: [] },                                                              // ← 空回合（根因）
  { role: 'user', content: '继续' },
  { role: 'assistant', content: [{ type: 'text', text: '最终回答。' }] },                          // ← 正常
];

await openaiProvider.call('system', messages, 'key', 'model', [], 'https://example.com');

// 1. 请求体里不能有 content:null 且无 tool_calls 的 assistant
const invalid = capturedMessages.filter(m => m.role === 'assistant' && (m.content == null) && !m.tool_calls);
assert('请求体无「content=null 且无 tool_calls」的 assistant 消息', invalid.length === 0);

// 2. 空 assistant 被跳过 → 只剩 2 个 assistant（tool_use 那轮 + 最终回答那轮）
const assistants = capturedMessages.filter(m => m.role === 'assistant');
assert('空 assistant 被跳过（assistant 数量 == 2）', assistants.length === 2);

// 3. tool_use 那轮保留 tool_calls，正常
const toolCallMsg = capturedMessages.find(m => m.role === 'assistant' && m.tool_calls);
assert('tool_use 消息的 tool_calls 保留', !!toolCallMsg && toolCallMsg.tool_calls.length === 1);

// 4. 空字符串 content 的 assistant 也被跳过
{
  capturedMessages = null;
  const msgs2 = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '' },       // 空字符串
    { role: 'user', content: '继续' },
  ];
  await openaiProvider.call('system', msgs2, 'key', 'model', [], 'https://example.com');
  const bad = capturedMessages.filter(m => m.role === 'assistant' && (m.content == null || m.content === '') && !m.tool_calls);
  assert('空字符串 content 的 assistant 也被跳过', bad.length === 0);
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
