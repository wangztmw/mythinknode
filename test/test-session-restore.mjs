// 会话恢复 + 即时命名 回归测试
// 用法: node Plan/cli-test/test-session-restore.mjs（需先 npm run build）
//
// 覆盖两件事：
//   1) 恢复会话时要重放历史对话（historyToBlocks 的过滤/合并/截断规则）
//   2) 会话命名要在第一条消息到达时立即发生（零 LLM 调用），而不是等 /exit
//
// 必须用临时 HOME：SESSIONS_DIR 在模块加载时由 homedir() 决定，
// 所以先改 process.env.HOME 再动态 import，避免污染真实 ~/.mythinknode。
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'mtn-session-test-'));
process.env.HOME = HOME;

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const { historyToBlocks, historyStats } = await import('../dist/session/session_history.js');
const { Session } = await import('../dist/session/session_manage.js');

const SESSIONS_DIR = join(HOME, '.mythinknode', 'sessions');

// ============================================================
console.log('\n=== 1. 历史重放：过滤注入消息 ===\n');
// ============================================================
{
  const messages = [
    { role: 'user', content: '帮我查一下知识库' },
    { role: 'assistant', content: [{ type: 'text', text: '好的，我来看。' }] },
    // 注入的检索结果 —— 不能当成用户发言重放
    { role: 'user', content: '[S1] 之前压缩的摘要内容' },
    { role: 'user', content: '[NODE MIND — relevant past experience]\n...' },
    { role: 'user', content: '[TRAIT GRAPH — your earlier thinking-execution trail]\n...' },
    { role: 'user', content: '[Agent "x" done. Use Agent(action=\'check\', taskId=\'1\').]' },
    // tool_result 是数组内容，跳过
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    { role: 'user', content: '   ' }, // 空白
    { role: 'user', content: '再看一下那个文件' },
  ];
  const blocks = historyToBlocks(messages);
  const users = blocks.filter(b => b.kind === 'user');
  assert('只重放 2 条真实用户发言', users.length === 2, `实际 ${users.length}`);
  assert('注入的 [S1] 被过滤', !blocks.some(b => b.text.includes('[S1]')));
  assert('注入的 [NODE MIND] 被过滤', !blocks.some(b => b.text.includes('[NODE MIND]')));
  assert('注入的 [TRAIT GRAPH] 被过滤', !blocks.some(b => b.text.includes('[TRAIT GRAPH]')));
  assert('注入的 [Agent ...] 被过滤', !blocks.some(b => b.text.includes('[Agent')));
  assert('空白发言被过滤', !blocks.some(b => b.kind === 'user' && !b.text.trim()));
  assert('assistant 文本重放为 md', blocks.some(b => b.kind === 'md' && b.text.includes('我来看')));
}

// ============================================================
console.log('\n=== 2. 历史重放：工具名合并成一行 ===\n');
// ============================================================
{
  const messages = [
    { role: 'assistant', content: [
      { type: 'text', text: '并行调用三个工具。' },
      { type: 'tool_use', id: 'a', name: 'Read', input: {} },
      { type: 'tool_use', id: 'b', name: 'Grep', input: {} },
      { type: 'tool_use', id: 'c', name: 'Glob', input: {} },
    ] },
  ];
  const blocks = historyToBlocks(messages);
  const tools = blocks.filter(b => b.kind === 'tool');
  assert('三个工具合成 1 行', tools.length === 1, `实际 ${tools.length}`);
  assert('工具名按序拼接', tools[0].text === 'Read, Grep, Glob', tools[0]?.text);
  assert('assistant 文本在工具行之前', blocks[0].kind === 'md');
}

// ============================================================
console.log('\n=== 3. 历史重放：截断 ===\n');
// ============================================================
{
  const long = 'x'.repeat(500);
  const blocks = historyToBlocks([{ role: 'user', content: long }], { maxChars: 100 });
  assert('超长块被截断', blocks[0].text.length < 500);
  assert('截断处有标记', blocks[0].text.includes('truncated'));

  const many = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
  const tail = historyToBlocks(many, { maxMessages: 10 });
  assert('maxMessages 只保留尾部 10 条', tail.length === 10, `实际 ${tail.length}`);
  assert('保留的是最后一条', tail[tail.length - 1].text === 'msg 49', tail[tail.length - 1]?.text);
}

// ============================================================
console.log('\n=== 4. historyStats ===\n');
// ============================================================
{
  const stats = historyStats([
    { role: 'user', content: 'a' },
    { role: 'user', content: '[S1] 注入' },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
  ]);
  assert('messages 计数含全部', stats.messages === 4);
  assert('users 排除注入', stats.users === 1);
  assert('assistantTexts 只算有文本的', stats.assistantTexts === 1);
}

// ============================================================
console.log('\n=== 5. 即时命名：零 LLM 调用 ===\n');
// ============================================================
{
  const s = new Session('20261110-103500', new Date('2026-11-10T10:35:00').getTime());
  let llmCalled = false;
  const spyLlm = { chat: async () => { llmCalled = true; return { content: [], stop_reason: 'end_turn' }; } };
  const renamed = s.provisionalBaseName('帮我优化一下会话恢复');
  assert('首条消息就触发命名', renamed === true);
  assert('命名过程没有调 LLM', llmCalled === false);
  assert('名字带创建时间前缀', s.id.startsWith('20261110-1035-'), s.id);
  assert('名字含意图短语', s.id.includes('帮我优化一下会话恢复'), s.id);
  assert('baseNameSource 标记为 provisional', s.baseNameSource === 'provisional');
  assert('firstUserMessage 被记下', s.firstUserMessage === '帮我优化一下会话恢复');

  // 重复调用不应改名
  const again = s.provisionalBaseName('另一句话');
  assert('已有名字时不重复命名', again === false && s.id.includes('帮我优化'), s.id);

  // 静默验证 spy 没被调用
  await s.ensureBaseName(spyLlm);
  assert('provisional → llm 升级时才调 LLM', llmCalled === true);
  // spy 返回空内容 → extractIntent 得到空串 → 不应升级为终态（否则名字会被空串覆盖）
  assert('LLM 返回空时不升级为终态', s.baseNameSource === 'provisional', s.baseNameSource);

  // 返回有效文本时才算升级成功
  const goodLlm = { chat: async () => ({ content: [{ type: 'text', text: '会话恢复优化' }], stop_reason: 'end_turn' }) };
  await s.ensureBaseName(goodLlm);
  assert('LLM 返回有效意图后标记为 llm', s.baseNameSource === 'llm', s.baseNameSource);
  assert('升级后名字来自 LLM', s.id.includes('会话恢复优化'), s.id);
}

// ============================================================
console.log('\n=== 6. 即时命名：多行输入取首行 ===\n');
// ============================================================
{
  const s = new Session('t1', Date.now());
  s.provisionalBaseName('第一行意图\n第二行细节\n第三行');
  assert('多行输入只取第一行', s.id.includes('第一行意图') && !s.id.includes('第二行'), s.id);
}

// ============================================================
console.log('\n=== 7. 即时命名：英文按词边界截断 ===\n');
// ============================================================
{
  const s = new Session('t2', Date.now());
  s.provisionalBaseName('fix the session restore and naming behavior please');
  const intent = s.id.split('-').slice(2).join('-');
  assert('英文不切半个单词', !/\w$/.test(intent) || intent.split('-').every(w => w.length > 0), intent);
  // 预算已由 12 收紧到 NAME_MAX_CHARS(15)（见 test-session-name-length.mjs）。
  // 这里用码点计数，与 session_name.ts 的口径保持一致。
  assert('英文命名字符数受控（≤ 15）', Array.from(intent).length <= 15, `${Array.from(intent).length}: ${intent}`);
}

// ============================================================
console.log('\n=== 8. 目录真的被改名了 ===\n');
// ============================================================
{
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const s = new Session('20261110-110000', new Date('2026-11-10T11:00:00').getTime());
  s.addMessage({ role: 'user', content: '部署网站到服务器' });
  s.firstUserMessage = '部署网站到服务器';
  s.save();
  const before = join(SESSIONS_DIR, '20261110-110000');
  assert('命名前目录是时间戳', existsSync(before));

  s.provisionalBaseName();
  const after = join(SESSIONS_DIR, s.id);
  assert('命名后目录带意图', s.id.includes('部署网站到服务器'), s.id);
  assert('新目录存在', existsSync(after));
  assert('旧目录已消失', !existsSync(before));
  assert('目录内有 session.json', existsSync(join(after, 'session.json')));
}

// ============================================================
console.log('\n=== 9. 改名后锁文件同步（否则恢复不了）===\n');
// ============================================================
{
  const s = new Session('20261110-120000', new Date('2026-11-10T12:00:00').getTime());
  s.lock();
  s.firstUserMessage = '整理知识库结构';
  s.addMessage({ role: 'user', content: '整理知识库结构' });
  s.save();
  assert('锁文件指向时间戳 id', JSON.parse(readFileSync(join(SESSIONS_DIR, '.lock'), 'utf-8')).id === '20261110-120000');

  s.provisionalBaseName();
  const lockId = JSON.parse(readFileSync(join(SESSIONS_DIR, '.lock'), 'utf-8')).id;
  assert('改名后锁文件指向新 id', lockId === s.id, `锁=${lockId} 实际=${s.id}`);
  assert('hasUnfinished 仍然为真', Session.hasUnfinished() === true);

  const loaded = Session.load();
  assert('能按锁文件加载回会话', loaded !== null && loaded.id === s.id);
  assert('加载回的消息还在', loaded.messages.some(m => m.content === '整理知识库结构'));
  s.unlock();
}

// ============================================================
console.log('\n=== 10. baseNameSource 持久化 + 老会话兼容 ===\n');
// ============================================================
{
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const s = new Session('20261110-130000', new Date('2026-11-10T13:00:00').getTime());
  s.firstUserMessage = '测试持久化';
  s.provisionalBaseName();
  s.save();

  const reloaded = Session.loadById(s.id);
  assert('provisional 标记被持久化', reloaded?.baseNameSource === 'provisional', reloaded?.baseNameSource);

  // 老会话：有 baseName 但没有 baseNameSource 字段（升级前写的）
  const legacyId = 'legacy-session';
  mkdirSync(join(SESSIONS_DIR, legacyId), { recursive: true });
  writeFileSync(join(SESSIONS_DIR, legacyId, 'session.json'), JSON.stringify({
    id: legacyId,
    startedAt: Date.now(),
    messages: [{ role: 'user', content: '老会话的一句话' }],
    baseName: '20260801-1200-老会话',
    // 注意：没有 baseNameSource
  }, null, 2));
  const legacy = Session.loadById(legacyId);
  assert('老会话 baseName 保留', legacy?.baseName === '20260801-1200-老会话');
  assert('老会话视为 llm 终态（不会被打回时间戳名）', legacy?.baseNameSource === 'llm', legacy?.baseNameSource);
  assert('老会话不再被重命名', legacy.provisionalBaseName() === false);
}

// ============================================================
console.log('\n=== 11. LLM 命名失败不倒退 ===\n');
// ============================================================
{
  const s = new Session('20261110-140000', new Date('2026-11-10T14:00:00').getTime());
  s.firstUserMessage = '写一个解析器';
  s.provisionalBaseName();
  const provisionalId = s.id;

  const brokenLlm = { chat: async () => { throw new Error('offline'); } };
  await s.ensureBaseName(brokenLlm);
  assert('LLM 抛异常时保留原名字', s.id === provisionalId, s.id);
  assert('仍然不是时间戳 id', /[^\d-]/.test(s.id), s.id);
  assert('标记仍为 provisional', s.baseNameSource === 'provisional');

  const emptyLlm = { chat: async () => ({ content: [], stop_reason: 'end_turn' }) };
  await s.ensureBaseName(emptyLlm);
  assert('LLM 返回空时保留原名字', s.id === provisionalId, s.id);

  await s.summarize(brokenLlm);
  assert('summarize 全失败也不退回时间戳', s.id === provisionalId, s.id);
}

// ============================================================
console.log('\n=== 12. summarize 仍能生成尾缀 ===\n');
// ============================================================
{
  const s = new Session('20261110-150000', new Date('2026-11-10T15:00:00').getTime());
  s.firstUserMessage = '优化会话恢复';
  s.addMessage({ role: 'user', content: '优化会话恢复' });
  s.addMessage({ role: 'user', content: '要能看到历史' });
  s.addMessage({ role: 'user', content: '名字要一开始就有' });
  s.provisionalBaseName();

  let calls = 0;
  const fakeLlm = {
    chat: async () => {
      calls++;
      // 第一次是 ensureBaseName（已是 llm 会跳过），之后是尾缀
      return { content: [{ type: 'text', text: calls === 1 ? '恢复历史与即时命名' : '尾缀概括' }], stop_reason: 'end_turn' };
    },
  };
  await s.summarize(fakeLlm);
  assert('生成了尾缀', s.id.endsWith('尾缀概括') || s.id.includes('尾缀概括'), s.id);
  assert('尾缀不累积（不出现两次）', (s.id.match(/尾缀概括/g) ?? []).length === 1, s.id);
}

// ============================================================
console.log('\n=== 13. 会话列表能按新名字排序显示 ===\n');
// ============================================================
{
  const all = Session.listAll();
  assert('listAll 返回数组', Array.isArray(all));
  assert('新命名会话出现在列表里', all.some(s => s.id.includes('部署网站到服务器')), JSON.stringify(all.map(s => s.id)));
  assert('按 id 倒序', all.length < 2 || all[0].id >= all[1].id);
}

// ============================================================
console.log('\n=== 14. 改名后 session.json 的 id 与目录名一致（防重复会话）===\n');
// ============================================================
{
  const s = new Session('20261110-160000', new Date('2026-11-10T16:00:00').getTime());
  s.firstUserMessage = '检查重复会话';
  s.addMessage({ role: 'user', content: '检查重复会话' });
  s.save();
  s.provisionalBaseName();
  s.save();

  const json = JSON.parse(readFileSync(join(SESSIONS_DIR, s.id, 'session.json'), 'utf-8'));
  assert('session.json 的 id 已随目录名更新', json.id === s.id, `文件=${json.id} 目录=${s.id}`);

  const dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  assert('没有残留旧目录', !dirs.includes('20261110-160000'), JSON.stringify(dirs));
  assert('只有一份本会话目录', dirs.filter(d => d.includes('检查重复会话')).length === 1);

  const reloaded = Session.loadById(s.id);
  assert('loadById 返回的 id 与目录名一致', reloaded?.id === s.id, reloaded?.id);
}

// ============================================================
console.log('\n=== 15. 接线：两个 CLI 都暴露 restoreHistory，主循环会调用 ===\n');
// ============================================================
{
  const SRC = new URL('../src/', import.meta.url).pathname;
  const { readFileSync: rf } = await import('node:fs');
  const main = rf(join(SRC, 'Mythinknode.ts'), 'utf8');
  const classic = rf(join(SRC, 'cli/cli.ts'), 'utf8');
  const tui = rf(join(SRC, 'cli/tui/session.tsx'), 'utf8');

  assert('classic CLI 暴露 restoreHistory', /restoreHistory\s*[:,]/.test(classic));
  assert('TUI CLI 暴露 restoreHistory', /restoreHistory\s*\(/.test(tui));
  assert('主循环调用 cli.restoreHistory', /cli\.restoreHistory\(session\.messages\)/.test(main));

  // 重放必须在 banner 之后、第一次 readLine 之前，否则会被 banner 盖掉或永不执行
  const bannerIdx = main.indexOf('cli.writeLines(\n    `mythinknode v${VERSION}');
  const restoreIdx = main.indexOf('cli.restoreHistory(');
  const loopIdx = main.indexOf('while (true)');
  assert('重放在 banner 之后', restoreIdx > bannerIdx && bannerIdx > 0, `banner=${bannerIdx} restore=${restoreIdx}`);
  assert('重放在主循环之前', restoreIdx < loopIdx && loopIdx > 0, `restore=${restoreIdx} loop=${loopIdx}`);
  assert('重放由 resumed 标志保护（新会话不做）', /if \(resumed\)\s*\{[\s\S]{0,200}restoreHistory/.test(main));

  // 两个 CLI 必须共用同一个重放规则实现
  assert('classic 复用 historyToBlocks', classic.includes("from '../session/session_history.js'"));
  assert('TUI 复用 historyToBlocks', tui.includes("from '../../session/session_history.js'"));

  // 即时命名接线：主循环在 runSession 之前调用
  const provIdx = main.indexOf('provisionalBaseName(line)');
  const runIdx = main.indexOf('await runSession(');
  assert('即时命名在 runSession 之前', provIdx > 0 && provIdx < runIdx, `prov=${provIdx} run=${runIdx}`);

  // 恢复时整体接管 session，而不是逐字段拷贝（逐字段会漏 firstUserMessage/baseName/keywordIndex）
  assert('恢复时整体接管 session 对象', /session = picked/.test(main));
  assert('不再逐字段拷贝', !/session\.pendingNotifications = picked\.pendingNotifications/.test(main));
}

// ---- 清理 ----
try { rmSync(HOME, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n结果: ${PASS} 通过, ${FAIL} 失败\n`);
process.exit(FAIL === 0 ? 0 : 1);
