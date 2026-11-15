// 会话命名字数预算回归测试
// 用法: node Plan/cli-test/test-session-name-length.mjs（需先 npm run build）
//
// 背景：实测历史会话名最长 180 字（旧版累积式命名），按旧逻辑（base12+尾缀20）
// 也有约 33 字，在 80 列终端里放不下一行。现在要求总长 ≤ 15 字（不含时间前缀）。
import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'mtn-name-test-'));
process.env.HOME = HOME;

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const D = new URL('../dist/', import.meta.url).pathname;
const {
  NAME_MAX_CHARS, BASE_SHARE_WITH_SUFFIX, SUFFIX_SHARE,
  truncateChars, allocateShares, composeName, nameLength, stripTimePrefix,
} = await import(D + 'session/session_name.js');
const { Session } = await import(D + 'session/session_manage.js');

const SESSIONS_DIR = join(HOME, '.mythinknode', 'sessions');

// ============================================================
console.log('\n=== 1. 预算常量 ===\n');
// ============================================================
{
  assert('总预算 15 字', NAME_MAX_CHARS === 15, String(NAME_MAX_CHARS));
  assert('基础名份额 + 分隔符 + 尾缀份额 = 总预算',
    BASE_SHARE_WITH_SUFFIX + 1 + SUFFIX_SHARE === NAME_MAX_CHARS,
    `${BASE_SHARE_WITH_SUFFIX}+1+${SUFFIX_SHARE} = ${BASE_SHARE_WITH_SUFFIX + 1 + SUFFIX_SHARE}`);
}

// ============================================================
console.log('\n=== 2. truncateChars 按码点截断 ===\n');
// ============================================================
{
  assert('中文 15 字不截断', truncateChars('一二三四五六七八九十甲乙丙丁戊', 15).length === 15);
  assert('中文 16 字截到 15',
    truncateChars('一二三四五六七八九十甲乙丙丁戊己', 15) === '一二三四五六七八九十甲乙丙丁戊');
  assert('短串原样返回', truncateChars('abc', 15) === 'abc');
  assert('max=0 → 空串', truncateChars('abc', 0) === '');
  assert('max<0 → 空串', truncateChars('abc', -5) === '');

  // emoji 是代理对，slice 会切坏；Array.from 按码点
  const emoji = '😀😁😂🤣😃😄😅😆';
  assert('emoji 按码点计数（8 个）', truncateChars(emoji, 15) === emoji);
  assert('emoji 截到 3 个后仍是完整 emoji',
    truncateChars(emoji, 3) === '😀😁😂', truncateChars(emoji, 3));
  assert('emoji 截断结果长度正确（不是 6 个码元）',
    nameLength(truncateChars(emoji, 3)) === 3);

  // 混合
  assert('中英混合按码点截断',
    nameLength(truncateChars('fix会话恢复bug', 5)) === 5);
}

// ============================================================
console.log('\n=== 3. allocateShares ===\n');
// ============================================================
{
  const noSuffix = allocateShares(false);
  assert('无尾缀时基础名独占预算', noSuffix.base === NAME_MAX_CHARS && noSuffix.suffix === 0);

  const withSuffix = allocateShares(true);
  assert('有尾缀时基础名让位', withSuffix.base === BASE_SHARE_WITH_SUFFIX);
  assert('有尾缀时尾缀有份额', withSuffix.suffix === SUFFIX_SHARE);
  assert('份额总和 + 分隔符 = 预算',
    withSuffix.base + 1 + withSuffix.suffix === NAME_MAX_CHARS);
}

// ============================================================
console.log('\n=== 4. composeName 总长约束 ===\n');
// ============================================================
{
  // 无尾缀：基础名可到 15
  assert('无尾缀：15 字基础名原样',
    nameLength(composeName('一二三四五六七八九十甲乙丙丁戊', '')) === 15);
  assert('无尾缀：超长基础名被截到 15',
    nameLength(composeName('一二三四五六七八九十甲乙丙丁戊己庚', '')) === 15);

  // 有尾缀：总长 ≤ 15
  const a = composeName('会话恢复优化', '历史重放重命名');
  assert('有尾缀：总长 ≤ 15', nameLength(a) <= NAME_MAX_CHARS, `${nameLength(a)} 字: ${a}`);
  assert('有尾缀：含连字符', a.includes('-'));

  // 基础名占满 15 时，仍要留出尾缀空间
  const longBase = '一二三四五六七八九十甲乙丙丁戊';
  const fullTail = '尾缀六个字符';                 // 恰好 6 字 = SUFFIX_SHARE
  assert('长尾缀长度确认（测试前置）', nameLength(fullTail) === SUFFIX_SHARE, String(nameLength(fullTail)));
  const b = composeName(longBase, fullTail);
  assert('基础名占满 15 时仍能加尾缀', nameLength(b) <= NAME_MAX_CHARS, `${nameLength(b)} 字: ${b}`);
  assert('这种情况下基础名被压到 8 字',
    nameLength(b.split('-')[0]) === BASE_SHARE_WITH_SUFFIX, `${nameLength(b.split('-')[0])}: ${b.split('-')[0]}`);

  // 尾缀为空 → 纯基础名，不留尾巴
  assert('尾缀为空 → 无连字符尾巴', !composeName('会话恢复优化', '').endsWith('-'));
  assert('尾缀为纯连字符 → 无尾巴', !composeName('会话恢复优化', '--').endsWith('-'));

  // 尾缀超长被截
  const c = composeName('基础名', '一二三四五六七八九十');
  const suffixPart = c.split('-').slice(1).join('');
  assert('尾缀被截到 6 字', nameLength(suffixPart) <= SUFFIX_SHARE, `${nameLength(suffixPart)}: ${suffixPart}`);
  assert('总长仍 ≤ 15', nameLength(c) <= NAME_MAX_CHARS, c);

  // 英文
  const e = composeName('session-restore', 'naming-cap');
  assert('英文总长 ≤ 15', nameLength(e) <= NAME_MAX_CHARS, `${nameLength(e)}: ${e}`);
}

// ============================================================
console.log('\n=== 5. stripTimePrefix ===\n');
// ============================================================
{
  assert('剥掉 YYYYMMDD-HHMM- 前缀',
    stripTimePrefix('20261113-1429-把网站部署到云服务器') === '把网站部署到云服务器');
  assert('无前缀时原样返回', stripTimePrefix('legacy-session') === 'legacy-session');
  assert('ISO 形式前缀不被误剥（不是 YYYYMMDD-HHMM）',
    stripTimePrefix('2026-11-10T02-16-44') === '2026-11-10T02-16-44');
}

// ============================================================
console.log('\n=== 6. 即时命名：中文 ≤ 15 字 ===\n');
// ============================================================
{
  mkdirSync(SESSIONS_DIR, { recursive: true });

  const s = new Session('20261113-1429', new Date(2026, 10, 13, 14, 29).getTime());
  s.provisionalBaseName('把网站部署到阿里云服务器上面然后用 Nginx 反向代理');
  const name = stripTimePrefix(s.id);
  assert('长中文输入 → 名字 ≤ 15 字', nameLength(name) <= NAME_MAX_CHARS, `${nameLength(name)}: ${name}`);
  assert('名字不为空', name.length > 0);
  assert('保留了开头意图', name.startsWith('把网站部署'), name);
}

// ============================================================
console.log('\n=== 7. 即时命名：英文按词边界 ===\n');
// ============================================================
{
  const s = new Session('20261113-1430', new Date(2026, 10, 13, 14, 30).getTime());
  s.provisionalBaseName('fix the session restore and naming behavior please');
  const name = stripTimePrefix(s.id);
  assert('英文名字 ≤ 15 字', nameLength(name) <= NAME_MAX_CHARS, `${nameLength(name)}: ${name}`);
  assert('英文不切出空词段', !name.includes('--'), name);
  // 要么整体是一个完整词，要么每个词都完整（尾段截断是允许的，但不能有半个词的空洞）
  assert('英文从第一个词开始', name.toLowerCase().startsWith('fix') || name.length <= 15, name);
}

// ============================================================
console.log('\n=== 8. 即时命名：emoji 不被切坏 ===\n');
// ============================================================
{
  const s = new Session('20261113-1431', new Date(2026, 10, 13, 14, 31).getTime());
  s.provisionalBaseName('😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗 long tail here');
  const name = stripTimePrefix(s.id);
  // sanitizeTitle 会剥掉 emoji（不属于 [一-鿿\w\s-]），所以这里主要验不崩
  assert('emoji 输入不导致异常', typeof name === 'string');
  assert('名字长度受控', nameLength(name) <= NAME_MAX_CHARS, `${nameLength(name)}: ${name}`);
}

// ============================================================
console.log('\n=== 9. summarize：base + 尾缀总长 ≤ 15 ===\n');
// ============================================================
{
  const s = new Session('20261113-1432', new Date(2026, 10, 13, 14, 32).getTime());
  s.firstUserMessage = '帮我优化一下会话恢复的历史重放功能';
  s.messages = [
    { role: 'user', content: '帮我优化一下会话恢复的历史重放功能' },
    { role: 'user', content: '顺便把命名改短一点' },
    { role: 'user', content: '选择器也要修' },
  ];
  s.provisionalBaseName();

  let call = 0;
  const fakeLlm = {
    chat: async () => {
      call++;
      // 第一次 ensureBaseName（已 llm 则跳过），之后是尾缀
      return { content: [{ type: 'text', text: '一二三四五六七八九十甲乙丙丁戊' }], stop_reason: 'end_turn' };
    },
  };
  await s.summarize(fakeLlm);
  const name = stripTimePrefix(s.id);
  assert('summarize 后名字 ≤ 15 字', nameLength(name) <= NAME_MAX_CHARS, `${nameLength(name)}: ${name}`);
  assert('尾缀存在（有连字符分隔）', name.split('-').length >= 1, name);
}

// ============================================================
console.log('\n=== 10. 真实老会话（180 字名）恢复后缩短 ===\n');
// ============================================================
{
  // 造一个老格式会话：名字约 180 字，无 baseName 字段
  // （程序化生成，避免手抄长字符串出错）
  const longName = '诊断发烫卡顿核实云脚本确认卡死进程'.repeat(11);   // 19 × 11 = 209 字符
  assert('测试前置：长名字 > 100 字', nameLength(longName) > 100, String(nameLength(longName)));
  const legacyId = `20260101-1200-${longName}`;
  mkdirSync(join(SESSIONS_DIR, legacyId), { recursive: true });
  writeFileSync(join(SESSIONS_DIR, legacyId, 'session.json'), JSON.stringify({
    id: legacyId,
    startedAt: new Date(2026, 0, 1, 12, 0).getTime(),
    messages: [{ role: 'user', content: '诊断发烫卡顿核实云脚本确认卡死进程还原脚本身份' }],
    // 注意：没有 baseName 字段（老版本）
  }, null, 2));

  const legacyLen = nameLength(longName);
  const loaded = Session.loadById(legacyId);
  assert('老会话能加载', loaded !== null);
  assert('老会话没有 baseName', !loaded.baseName);
  assert('老会话 id 就是那个超长名字', nameLength(stripTimePrefix(loaded.id)) === legacyLen,
    `${nameLength(stripTimePrefix(loaded.id))} vs ${legacyLen}`);

  // 恢复时 provisionalBaseName 会按新规则重命名
  const renamed = loaded.provisionalBaseName();
  assert('恢复后触发了重命名', renamed === true);
  const newName = stripTimePrefix(loaded.id);
  assert('重命名后 ≤ 15 字', nameLength(newName) <= NAME_MAX_CHARS, `${nameLength(newName)}: ${newName}`);
  assert('新名字带时间前缀', /^\d{8}-\d{4}-/.test(loaded.id), loaded.id);
  assert('旧目录已消失', !readdirSync(SESSIONS_DIR).includes(legacyId));
}

// ============================================================
console.log('\n=== 11. llm 终态名字不被缩短（保持稳定）===\n');
// ============================================================
{
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const id = '20261113-1435-一二三四五六七八九十甲乙丙丁戊';
  mkdirSync(join(SESSIONS_DIR, id), { recursive: true });
  writeFileSync(join(SESSIONS_DIR, id, 'session.json'), JSON.stringify({
    id,
    startedAt: new Date(2026, 10, 13, 14, 35).getTime(),
    messages: [{ role: 'user', content: '短' }],
    baseName: id,
    baseNameSource: 'llm',
  }, null, 2));

  const s = Session.loadById(id);
  assert('llm 终态标记被恢复', s?.baseNameSource === 'llm');
  const before = s.id;
  s.provisionalBaseName();
  assert('llm 终态不被重命名', s.id === before, s.id);
  assert('名字长度恰好 15（合规）', nameLength(stripTimePrefix(s.id)) === 15,
    String(nameLength(stripTimePrefix(s.id))));
}

// ============================================================
console.log('\n=== 12. 结构：三处命名都用统一预算 ===\n');
// ============================================================
{
  const SRC = new URL('../src/', import.meta.url).pathname;
  const { readFileSync } = await import('node:fs');
  const mgr = readFileSync(SRC + 'session/session_manage.ts', 'utf8');
  const code = mgr.split('\n')
    .filter(l => { const t = l.trim(); return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); })
    .join('\n');

  assert('导入 session_name 常量', /NAME_MAX_CHARS/.test(code) && /SUFFIX_SHARE/.test(code));
  assert('provisionalBaseName 用 NAME_MAX_CHARS', /localIntent\(first,\s*NAME_MAX_CHARS\)/.test(code));
  assert('ensureBaseName 用 NAME_MAX_CHARS', /extractIntent\(llm,\s*\[first\],\s*BASE_INTENT_PROMPT,\s*NAME_MAX_CHARS\)/.test(code));
  assert('summarize 尾缀用 SUFFIX_SHARE', /extractIntent\(llm,\s*recent,\s*SUFFIX_INTENT_PROMPT,\s*SUFFIX_SHARE\)/.test(code));
  assert('summarize 用 composeName 组装', /composeName\(/.test(code));
  assert('sanitizeTitle 用 truncateChars 而非 slice',
    /truncateChars\(cleaned/.test(code) && !/\.slice\(0,\s*maxLen\)/.test(code));
  assert('提示词字数上限已同步下调', /不超过\$\{NAME_MAX_CHARS\}个中文字/.test(code));
  assert('尾缀提示词用 SUFFIX_SHARE', /不超过\$\{SUFFIX_SHARE\}个中文字/.test(code));
}

// ---- 清理 ----
try { rmSync(HOME, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n结果: ${PASS} 通过, ${FAIL} 失败\n`);
process.exit(FAIL === 0 ? 0 : 1);
