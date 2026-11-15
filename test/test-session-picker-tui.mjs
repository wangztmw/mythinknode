// 交互式会话选择器 —— 状态机 / 布局 / 渲染 单测
// 用法: node Plan/cli-test/test-session-picker-tui.mjs（需先 npm run build）
//
// 不依赖 PTY：applyKey 是纯函数，renderFrame 输出字符串可断言。
// 真实终端行为见 pty-session-restore.py 第 7 组。
import { EventEmitter } from 'node:events';

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const D = new URL('../dist/', import.meta.url).pathname;
const {
  parseKey, applyKey, initialState, ensureVisible, computeLayout,
  renderFrame, pickSessionInteractive, ESC_TIMEOUT_MS,
} = await import(D + 'session/session_picker_tui.js');
const { previewMessages, formatSessionList, truncateToWidth } = await import(D + 'session/session_picker.js');

// 37 个会话（复现"很多会话"的真实场景）
const ROWS = Array.from({ length: 37 }, (_, i) => ({
  id: `202611${String(13 - Math.floor(i / 10)).padStart(2, '0')}-${String(9).padStart(2, '0')}${String(i % 10)}-会话${i + 1}`,
  messages: i + 1,
  toolCount: 0,
  startedAt: Date.now() - i * 3600_000,
}));

const key = (name, char) => ({ name, char });
const run = (state, k, page = 10) => applyKey(state, k, ROWS, page);

// ============================================================
console.log('\n=== 1. parseKey：转义序列 → 语义按键 ===\n');
// ============================================================
{
  assert('↑ \\x1b[A → up', parseKey('\x1b[A')?.name === 'up');
  assert('↓ \\x1b[B → down', parseKey('\x1b[B')?.name === 'down');
  assert('↑ \\x1bOA（应用模式）→ up', parseKey('\x1bOA')?.name === 'up');
  assert('PgUp \\x1b[5~ → page-up', parseKey('\x1b[5~')?.name === 'page-up');
  assert('PgDn \\x1b[6~ → page-down', parseKey('\x1b[6~')?.name === 'page-down');
  assert('Home \\x1b[H → home', parseKey('\x1b[H')?.name === 'home');
  assert('End \\x1b[F → end', parseKey('\x1b[F')?.name === 'end');
  assert('Enter \\r → enter', parseKey('\r')?.name === 'enter');
  assert('Enter \\n → enter', parseKey('\n')?.name === 'enter');
  assert('Backspace \\x7f → backspace', parseKey('\x7f')?.name === 'backspace');
  assert('Ctrl+C → abort', parseKey('\x03')?.name === 'abort');
  assert('Ctrl+D → eof', parseKey('\x04')?.name === 'eof');
  assert('j → down', parseKey('j')?.name === 'down');
  assert('k → up', parseKey('k')?.name === 'up');
  assert('g → home', parseKey('g')?.name === 'home');
  assert('G → end', parseKey('G')?.name === 'end');
  assert('n → new', parseKey('n')?.name === 'new');
  assert('q → abort', parseKey('q')?.name === 'abort');
  assert('数字 → char', parseKey('3')?.name === 'char' && parseKey('3').char === '3');

  // 关键：半截序列必须返回 null（等待后续字节），不能当 Esc
  assert('半截 \\x1b → null（不立即判 Esc）', parseKey('\x1b') === null);
  assert('半截 \\x1b[ → null', parseKey('\x1b[') === null);
  assert('半截 \\x1b[5 → null', parseKey('\x1b[5') === null);
  // 完整序列 + 额外字符：取第一个按键
  assert('\\x1b[A 带尾随字符 → up', parseKey('\x1b[Aextra')?.name === 'up');
}

// ============================================================
console.log('\n=== 2. 移动选择 ===\n');
// ============================================================
{
  let s = initialState(ROWS, null);
  assert('初始 cursor = 0', s.cursor === 0);

  s = run(s, key('down')).state;
  assert('↓ → cursor 1', s.cursor === 1);
  s = run(s, key('down')).state;
  s = run(s, key('down')).state;
  assert('↓↓↓ → cursor 3', s.cursor === 3);
  s = run(s, key('up')).state;
  assert('↑ → cursor 2', s.cursor === 2);

  // 边界不环绕
  let top = initialState(ROWS, null);
  top = run(top, key('up')).state;
  assert('在 0 处按 ↑ 保持 0（不环绕到末尾）', top.cursor === 0, String(top.cursor));

  let end = { ...initialState(ROWS, null), cursor: ROWS.length - 1 };
  end = run(end, key('down')).state;
  assert('在末项按 ↓ 保持末项', end.cursor === ROWS.length - 1, String(end.cursor));

  // PageDown / PageUp
  let p = initialState(ROWS, null);
  p = run(p, key('page-down'), 10).state;
  assert('PgDn → cursor += 10', p.cursor === 10, String(p.cursor));
  p = run(p, key('page-up'), 10).state;
  assert('PgUp → cursor -= 10', p.cursor === 0, String(p.cursor));

  // Home / End
  let h = { ...initialState(ROWS, null), cursor: 20 };
  h = run(h, key('home')).state;
  assert('Home → 0', h.cursor === 0);
  h = run(h, key('end')).state;
  assert('End → 36', h.cursor === 36, String(h.cursor));
}

// ============================================================
console.log('\n=== 3. 视口滚动 ===\n');
// ============================================================
{
  // 视口 10 行，光标移到底部外 → scrollTop 跟随
  let s = { cursor: 0, scrollTop: 0, digits: '', notice: null };
  s = ensureVisible(s, 10);
  assert('cursor 0 在顶部时 scrollTop = 0', s.scrollTop === 0);

  s = ensureVisible({ ...s, cursor: 9 }, 10);
  assert('cursor 9 仍在首屏（0..9）', s.scrollTop === 0, String(s.scrollTop));

  s = ensureVisible({ ...s, cursor: 10 }, 10);
  assert('cursor 10 移出底部 → scrollTop = 1', s.scrollTop === 1, String(s.scrollTop));

  s = ensureVisible({ ...s, cursor: 30 }, 10);
  assert('cursor 30 → scrollTop = 21（30-10+1）', s.scrollTop === 21, String(s.scrollTop));

  s = ensureVisible({ ...s, cursor: 0 }, 10);
  assert('光标移回顶部 → scrollTop 归 0', s.scrollTop === 0, String(s.scrollTop));

  // 最后一项
  s = ensureVisible({ ...s, cursor: 36 }, 10);
  assert('cursor 36 → scrollTop = 27（末屏完整）', s.scrollTop === 27, String(s.scrollTop));
}

// ============================================================
console.log('\n=== 4. 确认与终局 ===\n');
// ============================================================
{
  let s = { ...initialState(ROWS, null), cursor: 2 };
  let r = run(s, key('enter'));
  assert('Enter → picked 第 3 项', r.kind === 'done' && r.outcome.kind === 'picked' && r.outcome.id === ROWS[2].id,
    JSON.stringify(r.outcome));

  s = initialState(ROWS, null);
  r = run(s, key('abort'));
  assert('Ctrl+C → abort', r.kind === 'done' && r.outcome.kind === 'abort');

  r = run(s, key('eof'));
  assert('Ctrl+D → new', r.kind === 'done' && r.outcome.kind === 'new');

  r = run(s, key('new'));
  assert('n → new', r.kind === 'done' && r.outcome.kind === 'new');

  r = run(s, key('escape'));
  assert('Esc → abort', r.kind === 'done' && r.outcome.kind === 'abort');
}

// ============================================================
console.log('\n=== 5. 数字输入（兼容旧用法）===\n');
// ============================================================
{
  let s = initialState(ROWS, null);
  let r = run(s, key('char', '2'));
  assert('按 2 → digits="2" 且 cursor 跳到 1', r.state.digits === '2' && r.state.cursor === 1,
    `digits=${r.state.digits} cursor=${r.state.cursor}`);

  s = r.state;
  r = run(s, key('char', '5'));
  assert('再按 5 → digits="25" cursor=24', r.state.digits === '25' && r.state.cursor === 24,
    `digits=${r.state.digits} cursor=${r.state.cursor}`);

  r = run(r.state, key('enter'));
  assert('Enter → picked 第 25 项',
    r.kind === 'done' && r.outcome.id === ROWS[24].id, JSON.stringify(r.outcome));

  // Backspace 删除
  s = { ...initialState(ROWS, null), digits: '12', cursor: 11 };
  r = run(s, key('backspace'));
  assert('Backspace → digits="1"', r.state.digits === '1', r.state.digits);

  // 越界
  s = initialState(ROWS, null);
  r = run(s, key('char', '9'));
  r = run(r.state, key('char', '9'));
  assert('输 99（越界）→ 光标不动', r.state.cursor === 8, `cursor=${r.state.cursor}（99 越界后应停在 8，即 "9" 的位置）`);
  const before = r.state;
  r = run(before, key('enter'));
  assert('越界后 Enter → 不选中，回到 state + notice',
    r.kind === 'state' && /超出范围/.test(r.state.notice ?? ''), JSON.stringify(r.state.notice));
  assert('越界后 digits 被清空', r.state.digits === '');
}

// ============================================================
console.log('\n=== 6. 布局计算 ===\n');
// ============================================================
{
  const normal = computeLayout({ columns: 100, rows: 30 }, 37);
  assert('30 行终端：有预览', normal.previewRows > 0, JSON.stringify(normal));
  assert('列表行数 + 预览 + 2 头脚 ≤ 30',
    normal.listRows + normal.previewRows + 2 <= 30, JSON.stringify(normal));
  assert('预览上限 8 行', normal.previewRows <= 8, String(normal.previewRows));

  const compact = computeLayout({ columns: 100, rows: 10 }, 37);
  assert('10 行终端：紧凑模式无预览', compact.compact && compact.previewRows === 0, JSON.stringify(compact));

  const narrow = computeLayout({ columns: 40, rows: 30 }, 37);
  assert('40 列终端：narrow 模式', narrow.narrow === true);

  const fewItems = computeLayout({ columns: 100, rows: 30 }, 3);
  assert('只有 3 个会话时列表行数不超过 3', fewItems.listRows === 3, String(fewItems.listRows));
}

// ============================================================
console.log('\n=== 7. 渲染：全部会话可见 + 高亮 ===\n');
// ============================================================
{
  const layout = computeLayout({ columns: 100, rows: 30 }, ROWS.length);
  let s = { ...initialState(ROWS, null), cursor: 1 };

  const frame = renderFrame({ rows: ROWS, state: s, layout, lastId: null, preview: [], now: Date.now() });
  const lines = frame.split('\n').filter(Boolean);

  assert('表头显示总数 37（不是 20）', /可用会话（37 个）/.test(frame), lines[0]);
  // 页脚带 ANSI 颜色码（\x1b[2m2/37\x1b[0m），\b 会被前面的 'm' 挡掉 → 用裸匹配
  assert('页脚显示 2/37（不是 2/20）', frame.includes('2/37'), lines[lines.length - 1]);
  // 序号按总数宽度补空格（37 → 2 位），所以是 `▸  2. `（两个空格）
  assert('高亮行以 ▸ 开头', /▸\s+2\./.test(frame), '未找到 ▸ 2.');
  // 注意：不能用 /^\s*1\./ 之类判断未选中行 —— 序号可能补前导空格
  assert('未选中行以空格开头（不误用 ▸）',
    (frame.match(/▸/g) ?? []).length === 1, `${(frame.match(/▸/g) ?? []).length} 个 ▸`);

  // 滚到底部：应出现第 37 项
  const s2 = ensureVisible({ ...initialState(ROWS, null), cursor: 36 }, layout.listRows);
  const frame2 = renderFrame({ rows: ROWS, state: s2, layout, lastId: null, preview: [], now: Date.now() });
  assert('滚动到底部能看到第 37 项', /37\./.test(frame2), '未找到 37.');
  assert('顶部项已滚出视口（不再显示 1.）',
    !/^\s*1\./m.test(frame2.split('\n').slice(1, layout.listRows + 1).join('\n')),
    '第 1 项仍在视口内');

  // ←上次 标记
  const frame3 = renderFrame({
    rows: ROWS, state: { ...s, cursor: 0 }, layout, lastId: ROWS[0].id, preview: [], now: Date.now(),
  });
  assert('上次会话有标记', frame3.includes('←上次'), frame3.split('\n')[1]);
}

// ============================================================
console.log('\n=== 8. 渲染：预览面板 ===\n');
// ============================================================
{
  const layout = computeLayout({ columns: 100, rows: 30 }, ROWS.length);
  const preview = [
    { prefix: '> ', text: '帮我优化一下会话选择器' },
    { prefix: '  ', text: '好的，我看一下现在的实现' },
    { prefix: '⏺ ', text: 'Read(session_picker.ts)' },
  ];
  const frame = renderFrame({
    rows: ROWS, state: initialState(ROWS, null), layout, lastId: null, preview, now: Date.now(),
  });
  assert('预览区有标题', /预览/.test(frame), '未找到预览标题');
  assert('预览显示用户发言', frame.includes('帮我优化一下会话选择器'));
  assert('预览显示工具调用', frame.includes('Read(session_picker.ts)'));
  assert('紧凑模式下无预览',
    !/预览/.test(renderFrame({
      rows: ROWS, state: initialState(ROWS, null),
      layout: computeLayout({ columns: 100, rows: 10 }, ROWS.length),
      lastId: null, preview, now: Date.now(),
    })));
}

// ============================================================
console.log('\n=== 9. previewMessages：内容提取 ===\n');
// ============================================================
{
  const msgs = [
    { role: 'user', content: '[S1] 这是注入的压缩摘要，不该显示' },
    { role: 'user', content: '第一条真实发言' },
    { role: 'assistant', content: [{ type: 'text', text: '我来看看' }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', content: '文件内容' }] },
    { role: 'user', content: '第二条真实发言' },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
  ];
  const blocks = previewMessages(msgs, 10, 60);

  assert('过滤 [S1] 注入消息', !blocks.some(b => b.text.includes('[S1]')),
    JSON.stringify(blocks.map(b => b.text)));
  assert('包含真实用户发言', blocks.some(b => b.text === '第一条真实发言'));
  assert('包含工具调用及摘要', blocks.some(b => /Read\(a\.ts\)/.test(b.text)));
  assert('Bash 显示 command', blocks.some(b => /Bash\(npm test\)/.test(b.text)));
  assert('跳过 tool_result', !blocks.some(b => b.text.includes('文件内容')));

  // 只取最后 N 条
  const tail = previewMessages(msgs, 2, 60);
  assert('maxLines=2 时只取最后 2 条', tail.length === 2, JSON.stringify(tail));
  assert('取的是最后而不是最前',
    tail.some(b => b.text === '第二条真实发言'), JSON.stringify(tail.map(b => b.text)));

  // 多行压成一行
  const multi = previewMessages([{ role: 'user', content: 'a\n\nb\tc' }], 5, 60);
  assert('多行内容压成单行', multi[0].text === 'a b c', JSON.stringify(multi[0].text));

  // 宽度截断
  const long = previewMessages([{ role: 'user', content: 'x'.repeat(200) }], 5, 20);
  assert('超宽内容被截断并加省略号', long[0].text.endsWith('…'), long[0].text);
  assert('截断后不超过宽度', Array.from(long[0].text).length <= 20, String(Array.from(long[0].text).length));

  // 空消息
  assert('空消息返回空数组', previewMessages([], 5, 60).length === 0);
  assert('maxLines=0 返回空数组', previewMessages(msgs, 0, 60).length === 0);
}

// ============================================================
console.log('\n=== 10. 非 TTY 降级：全量输出不截断 ===\n');
// ============================================================
{
  const text = formatSessionList(ROWS, null, Date.now());
  const numbered = (text.match(/^\s+\d+\. /gm) ?? []).length;
  assert(`降级路径输出全部 ${ROWS.length} 条（不再是 20）`, numbered === ROWS.length, `${numbered} 条`);
  assert('不再有「只显示最近 N 个」的截断提示', !/只显示最近/.test(text));
}

// ============================================================
console.log('\n=== 11. 集成：pickSessionInteractive 真实事件流 ===\n');
// ============================================================
{
  const makeIO = () => {
    const stdin = new EventEmitter();
    stdin.isTTY = true;
    stdin.setRawMode = (m) => { stdin.rawMode = m; return true; };
    stdin.resume = () => {};
    stdin.pause = () => {};
    const out = [];
    const stdout = { columns: 100, rows: 30, write: (s) => { out.push(s); return true; } };
    return { stdin, stdout, out };
  };

  // ↓ ↓ Enter → 第 3 项
  let io = makeIO();
  let p = pickSessionInteractive(io, ROWS, null, { loadPreview: () => [] });
  io.stdin.emit('data', '\x1b[B');
  io.stdin.emit('data', '\x1b[B');
  io.stdin.emit('data', '\r');
  let r = await p;
  assert('↓↓ Enter → picked 第 3 项', r.kind === 'picked' && r.id === ROWS[2].id, JSON.stringify(r));
  assert('退出时还原了 raw mode', io.stdin.rawMode === false);

  // q → abort
  io = makeIO();
  p = pickSessionInteractive(io, ROWS, null, { loadPreview: () => [] });
  io.stdin.emit('data', 'q');
  r = await p;
  assert('q → abort', r.kind === 'abort');

  // 分帧的方向键（关键：不能把 \x1b 当 Esc 退出）
  io = makeIO();
  p = pickSessionInteractive(io, ROWS, null, { loadPreview: () => [] });
  io.stdin.emit('data', '\x1b');
  await new Promise(res => setTimeout(res, 5));   // 小于 ESC_TIMEOUT_MS
  io.stdin.emit('data', '[B');
  io.stdin.emit('data', '\r');
  r = await p;
  assert('分帧的 \\x1b + [B → down 再 Enter（未误判为 Esc 退出）',
    r.kind === 'picked' && r.id === ROWS[1].id, JSON.stringify(r));

  // 单独 Esc（超时后）→ abort
  io = makeIO();
  p = pickSessionInteractive(io, ROWS, null, { loadPreview: () => [] });
  io.stdin.emit('data', '\x1b');
  r = await p;
  assert('单独 Esc（超时）→ abort', r.kind === 'abort', JSON.stringify(r));

  // 预览被调用过一次（缓存生效）
  io = makeIO();
  let calls = 0;
  p = pickSessionInteractive(io, ROWS, null, { loadPreview: () => { calls++; return []; } });
  io.stdin.emit('data', '\x1b[B');
  io.stdin.emit('data', '\x1b[A');
  io.stdin.emit('data', '\x1b[B');
  io.stdin.emit('data', '\r');
  r = await p;
  assert('同一会话预览只加载一次（缓存）', calls <= 2, `${calls} 次`);

  // 渲染帧数：每按一次键重绘
  io = makeIO();
  p = pickSessionInteractive(io, ROWS, null, { loadPreview: () => [] });
  io.stdin.emit('data', '\x1b[B');
  io.stdin.emit('data', '\r');
  r = await p;
  const frames = io.out.filter(s => s.includes('可用会话')).length;
  assert('首帧 + 每次移动都重绘', frames >= 2, `${frames} 帧`);
}

// ============================================================
console.log('\n=== 12. 结构：接线正确 ===\n');
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const SRC = new URL('../src/', import.meta.url).pathname;
  const mgr = readFileSync(SRC + 'session/session_manage.ts', 'utf8');
  const code = mgr.split('\n')
    .filter(l => { const t = l.trim(); return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); })
    .join('\n');

  assert('pickSession 按 isTTY 分流', /isTTY === true/.test(code));
  assert('TERM=dumb 也降级', /TERM !== 'dumb'/.test(code));
  assert('TTY 走 pickSessionInteractive', /pickSessionInteractive\(/.test(code));
  assert('非 TTY 走 pickSessionFrom', /pickSessionFrom\(/.test(code));
  assert('预览用 previewMessages', /previewMessages\(/.test(code));

  const picker = readFileSync(SRC + 'session/session_picker.ts', 'utf8');
  assert('formatSessionList 不再截断到 MAX_ROWS',
    !/rows\.slice\(0,\s*MAX_ROWS\)/.test(picker.split('\n').join('\n').replace(/\/\*[\s\S]*?\*\//g, '')));
}

console.log(`\n结果: ${PASS} 通过, ${FAIL} 失败\n`);
process.exit(FAIL === 0 ? 0 : 1);
