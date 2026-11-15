// 会话选择器纯逻辑回归测试
// 用法: node Plan/cli-test/test-session-picker.mjs（需先 npm run build）
//
// 背景：旧实现是 `process.stdin.once('data')` + `parseInt`，一次 data 定生死。
// 缺陷：分帧早退 / Ctrl+C 被当成开新会话 / 非法输入静默降级 / 不显示相对时间。
// 本测试用假 stdin（EventEmitter）+ 假 stdout（收集字符串），不需要 PTY。
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const D = new URL('../dist/', import.meta.url).pathname;
const {
  readLineOnce, parseChoice, formatRelative, formatSessionList,
  parseStartedAtFromId, pickSessionFrom, MAX_ROWS,
} = await import(D + 'session/session_picker.js');

/** 假 I/O：stdin 是 EventEmitter，stdout 收集字符串 */
function makeIO() {
  const stdin = new EventEmitter();
  stdin.resume = () => {};
  stdin.pause = () => {};
  const out = [];
  return {
    io: { stdin, stdout: { write: (s) => { out.push(s); return true; } } },
    stdin,
    out,
    get text() { return out.join(''); },
  };
}

const ROWS = [
  { id: '20261113-1405-把网站部署到云服务器', messages: 12, toolCount: 3, startedAt: 1000 },
  { id: '20261112-1830-帮我优化一下会话恢复', messages: 37, toolCount: 8, startedAt: 2000 },
  { id: '20261101-0900-网站部署', messages: 6, toolCount: 2, startedAt: 3000 },
];

// ============================================================
console.log('\n=== 1. readLineOnce：分帧与同帧 ===\n');
// ============================================================
{
  // 分帧：'1' 然后 '\r'
  let h = makeIO();
  let p = readLineOnce(h.io);
  h.stdin.emit('data', '1');
  await new Promise(r => setImmediate(r));
  h.stdin.emit('data', '\r');
  let r = await p;
  assert('分帧 "1" + "\\r" → 拿到完整一行（不早退）',
    r.kind === 'line' && r.text === '1', JSON.stringify(r));

  // 同帧
  h = makeIO();
  p = readLineOnce(h.io);
  h.stdin.emit('data', '2\r');
  r = await p;
  assert('同帧 "2\\r" → 拿到第 2 行', r.kind === 'line' && r.text === '2', JSON.stringify(r));

  // 只有回车
  h = makeIO();
  p = readLineOnce(h.io);
  h.stdin.emit('data', '\r');
  r = await p;
  assert('单独回车 → 空行（不是 abort）', r.kind === 'line' && r.text === '');

  // 分帧的粘贴：'1' + '2' + '\r' → 完整 '12'
  h = makeIO();
  p = readLineOnce(h.io);
  h.stdin.emit('data', '1');
  h.stdin.emit('data', '2');
  h.stdin.emit('data', '\r');
  r = await p;
  assert('分帧 "1"+"2"+"\\r" → 完整 "12"（不早退到 "1"）',
    r.kind === 'line' && r.text === '12', JSON.stringify(r));

  // \n 也可以
  h = makeIO();
  p = readLineOnce(h.io);
  h.stdin.emit('data', '3\n');
  r = await p;
  assert('\\n 也当换行', r.kind === 'line' && r.text === '3');

  // \r\n
  h = makeIO();
  p = readLineOnce(h.io);
  h.stdin.emit('data', '4\r\n');
  r = await p;
  assert('\\r\\n 当一次换行（不残留空行）', r.kind === 'line' && r.text === '4');
}

// ============================================================
console.log('\n=== 2. readLineOnce：控制字符 ===\n');
// ============================================================
{
  let h = makeIO();
  let p = readLineOnce(h.io);
  h.stdin.emit('data', '\x03');
  let r = await p;
  assert('Ctrl+C (\\x03) → abort', r.kind === 'abort', JSON.stringify(r));

  h = makeIO();
  p = readLineOnce(h.io);
  h.stdin.emit('data', '\x04');
  r = await p;
  assert('Ctrl+D (\\x04) → eof', r.kind === 'eof', JSON.stringify(r));

  // 控制字符混在文本里：'1\x03' 应立即 abort，不能解析成 1
  h = makeIO();
  p = readLineOnce(h.io);
  h.stdin.emit('data', '1\x03');
  r = await p;
  assert('"1\\x03" → abort（不能解析成选 1）', r.kind === 'abort', JSON.stringify(r));

  // stdin 提前关闭
  h = makeIO();
  p = readLineOnce(h.io);
  h.stdin.emit('end');
  r = await p;
  assert('stdin end → eof', r.kind === 'eof', JSON.stringify(r));
}

// ============================================================
console.log('\n=== 3. readLineOnce：ANSI 转义序列 ===\n');
// ============================================================
{
  // 终端先发来鼠标/光标序列
  let h = makeIO();
  let p = readLineOnce(h.io);
  h.stdin.emit('data', '\x1b[2~');
  h.stdin.emit('data', '2\r');
  let r = await p;
  assert('剥掉 \\x1b[2~ 后正确解析', r.kind === 'line' && r.text === '2', JSON.stringify(r));

  // OSC 序列
  h = makeIO();
  p = readLineOnce(h.io);
  h.stdin.emit('data', '\x1b]0;title\x07' + '1\r');
  r = await p;
  assert('剥掉 OSC 序列后正确解析', r.kind === 'line' && r.text === '1', JSON.stringify(r));

  // 方向键序列出现在数字之后
  h = makeIO();
  p = readLineOnce(h.io);
  h.stdin.emit('data', '1\x1b[A\r');
  r = await p;
  assert('数字后的方向键序列被剥掉', r.kind === 'line' && r.text === '1', JSON.stringify(r));
}

// ============================================================
console.log('\n=== 4. parseChoice ===\n');
// ============================================================
{
  assert('"1" → index 1', JSON.stringify(parseChoice('1', 3)) === JSON.stringify({ kind: 'index', n: 1 }));
  assert('"3" → index 3', parseChoice('3', 3).kind === 'index' && parseChoice('3', 3).n === 3);
  assert('"0" → invalid（越界）', parseChoice('0', 3).kind === 'invalid');
  assert('"4" → invalid（越界）', parseChoice('4', 3).kind === 'invalid');
  assert('"" → new', parseChoice('', 3).kind === 'new');
  assert('"   " → new', parseChoice('   ', 3).kind === 'new');
  assert('"abc" → invalid', parseChoice('abc', 3).kind === 'invalid');
  assert('"1a" → invalid（不能用 parseInt 猜）', parseChoice('1a', 3).kind === 'invalid');
  assert('"1.5" → invalid', parseChoice('1.5', 3).kind === 'invalid');
  assert('"-1" → invalid', parseChoice('-1', 3).kind === 'invalid');
  assert('" 2 " → index 2（前后空白容忍）',
    parseChoice(' 2 ', 3).kind === 'index' && parseChoice(' 2 ', 3).n === 2);
  // 关键：旧实现 parseInt('\x033') === 3，会误选第 3 个
  assert('含 \\x03 的字符串 → invalid（旧实现会误选第 3 个）',
    parseChoice('\x033', 3).kind === 'invalid');
  assert('前导零 "01" → index 1', parseChoice('01', 3).kind === 'index' && parseChoice('01', 3).n === 1);
}

// ============================================================
console.log('\n=== 5. formatRelative ===\n');
// ============================================================
{
  const now = 1_000_000_000_000;
  const s = 1000, m = 60 * s, h = 60 * m, d = 24 * h;
  assert('10 秒前 → 刚刚', formatRelative(now - 10 * s, now) === '刚刚');
  assert('5 分钟前', formatRelative(now - 5 * m, now) === '5 分钟前');
  assert('3 小时前', formatRelative(now - 3 * h, now) === '3 小时前');
  assert('2 天前', formatRelative(now - 2 * d, now) === '2 天前');
  assert('90 天前 → 3 个月前', formatRelative(now - 90 * d, now) === '3 个月前');
  assert('undefined → 空串（不崩、不占位异常）', formatRelative(undefined, now) === '');
  assert('未来时间 → 空串', formatRelative(now + 10 * m, now) === '');
}

// ============================================================
console.log('\n=== 6. parseStartedAtFromId ===\n');
// ============================================================
{
  const ts = parseStartedAtFromId('20261113-1405-把网站部署到云服务器');
  assert('能从目录名解析时间', typeof ts === 'number' && Number.isFinite(ts));
  const d = new Date(ts);
  assert('解析出正确的年月日时分',
    d.getFullYear() === 2026 && d.getMonth() === 10 && d.getDate() === 13
    && d.getHours() === 14 && d.getMinutes() === 5,
    d.toString());
  assert('无时间戳前缀 → undefined', parseStartedAtFromId('legacy-session') === undefined);
  assert('ISO 形式 → undefined（不是 YYYYMMDD-HHMM）',
    parseStartedAtFromId('2026-11-10T02-16-44') === undefined);
}

// ============================================================
console.log('\n=== 7. formatSessionList 排版 ===\n');
// ============================================================
{
  const now = 3000 + 5 * 60_000;   // 相对 ROWS 的 startedAt
  const text = formatSessionList(ROWS, ROWS[0].id, now);
  assert('含条数标题', text.includes('可用会话（3 个）'), text.slice(0, 60));
  assert('含序号 1/2/3', /1\./.test(text) && /2\./.test(text) && /3\./.test(text));
  assert('含会话名', text.includes('把网站部署到云服务器'));
  assert('含相对时间', /分钟前|小时前|刚刚/.test(text), text);
  assert('含消息条数', /12 条消息/.test(text), text);
  assert('上次会话有标记', text.includes('← 上次'));
  assert('最后有提示行', text.includes('直接回车开新会话'));

  // lastId 为空时不显示标记
  const t2 = formatSessionList(ROWS, null, now);
  assert('无 lastId 时不出标记', !t2.includes('← 上次'));

  // startedAt 缺失 → 从目录名兜底
  const noTs = [{ id: '20260101-1200-测试', messages: 1, toolCount: 0 }];
  const t3 = formatSessionList(noTs, null, new Date(2026, 0, 3, 12, 0).getTime());
  assert('startedAt 缺失时从目录名兜底出相对时间', /天前/.test(t3), t3);

  // 超长 id 截断
  const longId = '20260101-1200-' + 'x'.repeat(80);
  const t4 = formatSessionList([{ id: longId, messages: 1, toolCount: 0 }], null, now);
  assert('超长会话名被截断并带省略号', t4.includes('…'), t4);
  assert('截断后不破坏列对齐（无换行错位）', t4.split('\n').filter(l => l.trim()).length >= 3);

  // 条目过多时：降级路径必须全量输出（没有滚动能力，截断会让用户永远够不到老会话）
  const many = Array.from({ length: 35 }, (_, i) => ({
    id: `20260101-${String(i).padStart(4, '0')}-会话${i}`,
    messages: i, toolCount: 0, startedAt: now - i * 60_000,
  }));
  const t5 = formatSessionList(many, null, now);
  const numbered = (t5.match(/^\s+\d+\. /gm) ?? []).length;
  assert('降级路径全量输出（不再截断到 20）', numbered === 35, `${numbered} 条`);
  assert('不再出现「只显示最近 N 个」的截断提示', !/只显示最近/.test(t5), t5.slice(-120));
  assert('最后一条也在列表里', t5.includes('会话34'), t5.slice(-160));
}

// ============================================================
console.log('\n=== 8. pickSessionFrom：完整流程 ===\n');
// ============================================================
{
  // 正常选择
  let h = makeIO();
  let p = pickSessionFrom(h.io, ROWS, null);
  h.stdin.emit('data', '2\r');
  let r = await p;
  assert('输入 2 → picked 第 2 个',
    r.kind === 'picked' && r.id === ROWS[1].id, JSON.stringify(r));
  assert('列表已输出', h.text.includes('可用会话'));

  // 空回车
  h = makeIO();
  p = pickSessionFrom(h.io, ROWS, null);
  h.stdin.emit('data', '\r');
  r = await p;
  assert('空回车 → new', r.kind === 'new', JSON.stringify(r));

  // Ctrl+C
  h = makeIO();
  p = pickSessionFrom(h.io, ROWS, null);
  h.stdin.emit('data', '\x03');
  r = await p;
  assert('Ctrl+C → abort', r.kind === 'abort', JSON.stringify(r));

  // Ctrl+D
  h = makeIO();
  p = pickSessionFrom(h.io, ROWS, null);
  h.stdin.emit('data', '\x04');
  r = await p;
  assert('Ctrl+D → new', r.kind === 'new', JSON.stringify(r));

  // 非法 → 重问 → 正确
  h = makeIO();
  p = pickSessionFrom(h.io, ROWS, null);
  h.stdin.emit('data', 'abc\r');
  await new Promise(r2 => setImmediate(r2));
  assert('非法输入后有提示', /无效输入/.test(h.text), h.text.slice(-100));
  h.stdin.emit('data', '1\r');
  r = await p;
  assert('重问后输入 1 → picked', r.kind === 'picked' && r.id === ROWS[0].id, JSON.stringify(r));

  // 越界 → 重问
  h = makeIO();
  p = pickSessionFrom(h.io, ROWS, null);
  h.stdin.emit('data', '99\r');
  await new Promise(r2 => setImmediate(r2));
  assert('越界提示含范围', /1-3/.test(h.text), h.text.slice(-100));
  h.stdin.emit('data', '1\r');
  r = await p;
  assert('越界后输入 1 → picked', r.kind === 'picked');

  // 连续 3 次非法 → 放弃，不卡死
  h = makeIO();
  p = pickSessionFrom(h.io, ROWS, null, { maxRetries: 3 });
  for (let i = 0; i < 4; i++) {
    h.stdin.emit('data', 'zzz\r');
    await new Promise(r2 => setImmediate(r2));
  }
  r = await p;
  assert('连续无效后放弃 → new（不卡死）', r.kind === 'new', JSON.stringify(r));
  assert('放弃时有说明', /开新会话处理/.test(h.text), h.text.slice(-100));

  // 空列表
  h = makeIO();
  r = await pickSessionFrom(h.io, [], null);
  assert('空列表 → new（不阻塞等输入）', r.kind === 'new');
  assert('空列表不输出列表', h.text === '');

  // maxRetries=0 → 第一次非法就放弃
  h = makeIO();
  p = pickSessionFrom(h.io, ROWS, null, { maxRetries: 0 });
  h.stdin.emit('data', 'x\r');
  r = await p;
  assert('maxRetries=0 时首次非法即放弃', r.kind === 'new', JSON.stringify(r));
}

// ============================================================
console.log('\n=== 9. 结构：旧实现特征已消除 ===\n');
// ============================================================
{
  const SRC = new URL('../src/', import.meta.url).pathname;
  const mgr = readFileSync(SRC + 'session/session_manage.ts', 'utf8');
  const code = mgr.split('\n')
    .filter(l => { const t = l.trim(); return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); })
    .join('\n');

  assert('pickSession 不再用 stdin.once("data")', !/stdin\.once\(\s*['"]data['"]/.test(code));
  assert('pickSession 不再用 parseInt 解析选择', !/parseInt\(/.test(code));
  assert('pickSession 不再直接 console.log', !/console\.log\(/.test(code));
  assert('pickSession 返回类型含 abort', /Promise<Session \| null \| 'abort'>/.test(code));
  assert('pickSession 委托给 pickSessionFrom', /pickSessionFrom\(/.test(code));
  assert('SIGINT 临时处理器有安装和移除',
    /process\.on\('SIGINT'/.test(code) && /process\.off\('SIGINT'/.test(code));

  const main = readFileSync(SRC + 'Mythinknode.ts', 'utf8');
  assert('调用方处理 abort', /=== 'abort'/.test(main), '(Mythinknode.ts 未处理 abort)');
  assert('abort 时干净退出', /picked === 'abort'[\s\S]{0,300}process\.exit\(0\)/.test(main));
}

console.log(`\n结果: ${PASS} 通过, ${FAIL} 失败\n`);
process.exit(FAIL === 0 ? 0 : 1);
