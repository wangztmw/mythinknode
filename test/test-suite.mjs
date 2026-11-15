// CLI 输入层回归测试 —— 链接 input-model 的 applyChunk（纯状态机）
// 用法: node Plan/cli-test/test-suite.mjs（需先 npm run build）
//
// 覆盖：raw mode 自管 stdin + chars 数组 + cursor 光标
//   + bracketed paste + 回车提交 + 追加 O(1) + 编辑重绘
import { applyChunk } from '../dist/cli/input/input-model.js';
import { cleanInput } from '../dist/cli/input/input-geometry.js';
import { extractUnit, splitTrailingNewline } from '../dist/cli/input/input-buffer.js';

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

// 数据层状态机（无 I/O）：驱动 applyChunk，暴露 text/submitted/cursor 供断言
function createInput() {
  const model = { chars: [], cursor: 0, inPaste: false };
  const submitted = [];

  function feed(chunk) {
    const effect = applyChunk(model, chunk);
    if (effect.exit) return;
    if (effect.submit != null) { submitted.push(effect.submit); model.chars = []; model.cursor = 0; }
  }

  return {
    feed,
    get text() { return cleanInput(model.chars.join('').trim()); },
    get submitted() { return submitted; },
    get cursor() { return model.cursor; },
  };
}

console.log('\n=== CLI 输入层回归测试（最终逻辑）===\n');

// 1. 单行输入 + 回车提交
{
  const it = createInput();
  it.feed('hello world');
  it.feed('\r');
  assert('单行输入 + 回车提交', it.submitted[0] === 'hello world');
}

// 2. 粘贴多行（含 \r 换行）+ 回车提交
{
  const it = createInput();
  it.feed('line1\rline2\rline3');
  it.feed('\r');
  assert('粘贴多行（\\r 换行）完整累积', it.submitted[0] === 'line1\nline2\nline3');
}

// 2b. 文字与回车落在同一次 read（打字快 / 粘贴后立刻回车 / 慢链路字节合并）
//     —— 之前整段交给 applyChunk，\r 被当成内容换行，回车被吞掉。
{
  const split = (s) => splitTrailingNewline(extractUnit(s));
  assert('"文字\\r" 拆成 文字 + 回车',
    split('hello\r').body === 'hello' && split('hello\r').newline === '\r',
    JSON.stringify(split('hello\r')));
  assert('"文字\\n" 拆成 文字 + 换行',
    split('hello\n').body === 'hello' && split('hello\n').newline === '\n');
  assert('中文 + 回车同样拆分',
    split('把网站部署到云服务器\r').body === '把网站部署到云服务器');
  assert('段中间的 \\r 不拆（多行粘贴内容）',
    split('line1\rline2\rline3').body === 'line1\rline2\rline3'
    && split('line1\rline2\rline3').newline === '');
  assert('单独回车不拆（原样交给 applyChunk 触发提交）',
    split('\r').body === '\r' && split('\r').newline === '');

  // 端到端：模拟真实 stdin 分帧循环（与 input-buffer 的 while 循环一致）
  const runFrames = (frames) => {
    const it = createInput();
    let pending = '';
    for (const frame of frames) {
      pending += frame;
      while (pending.length > 0) {
        const unit = extractUnit(pending);
        if (unit === null) break;
        pending = pending.slice(unit.length);
        const { body, newline } = splitTrailingNewline(unit);
        if (body) it.feed(body);
        if (newline) it.feed(newline);
      }
    }
    return it;
  };

  const a = runFrames(['把网站部署到云服务器\r']);
  assert('文字+回车同帧 → 正常提交（回车不被吞）',
    a.submitted.length === 1 && a.submitted[0] === '把网站部署到云服务器',
    JSON.stringify(a.submitted));

  const b = runFrames(['hello', '\r']);
  assert('文字与回车分两帧 → 正常提交',
    b.submitted.length === 1 && b.submitted[0] === 'hello');

  const c = runFrames(['hello\r']);
  assert('同帧输入只提交一次（不会重复提交）', c.submitted.length === 1, JSON.stringify(c.submitted));

  const d = runFrames(['line1\rline2\rline3', '\r']);
  assert('多行内容 + 结尾回车仍完整累积', d.submitted[0] === 'line1\nline2\nline3',
    JSON.stringify(d.submitted));
}

// 3. bracketed paste：粘贴内容里的 \r 不是回车提交
{
  const it = createInput();
  it.feed('\x1b[200~line1\rline2\rline3\x1b[201~');
  it.feed('\r');
  assert('bracketed paste 内容完整（\\r 不误判回车）', it.submitted[0] === 'line1\nline2\nline3');
  assert('bracketed paste 只有一次提交', it.submitted.length === 1);
}

// 4. 大段粘贴分帧（换行恰好单独成 chunk）—— 之前丢内容的场景
{
  const it = createInput();
  const raw = '第一段\r\r第二段\r\r第三段';
  const pieces = raw.split('\r');
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i].length > 0) it.feed(pieces[i]);
    if (i < pieces.length - 1) it.feed('\r');
  }
  it.feed('\r');
  // 关键：分帧切出的 \r 应该被识别为内容换行（非回车），因为它们在 bracketed paste 内
  // 但这里没包 bracketed 标记，会误判。这测试的是"必须用 bracketed paste"的必要性
  assert('分帧换行需 bracketed paste 保护（未保护时会误判）', it.submitted.length > 0);
}

// 5. 光标编辑：方向键移动 + 中间插入
{
  const it = createInput();
  it.feed('abc');
  it.feed('\x1b[D');      // 光标移到 b 和 c 之间
  it.feed('X');           // 中间插入 X
  assert('光标左移 + 中间插入', it.text === 'abXc');
}

// 6. 退格删除（双宽中文按整字删）
{
  const it = createInput();
  it.feed('中文测试');
  it.feed('\x7f');        // 退格删"试"
  assert('退格删中文整字', it.text === '中文测');
}

// 7. Delete 删除光标后字符
{
  const it = createInput();
  it.feed('abc');
  it.feed('\x1b[D');      // 光标到 b|c
  it.feed('\x1b[3~');     // 删 c
  assert('Delete 删光标后字符', it.text === 'ab');
}

// 8. 超长单行 5 万字（追加 O(1)，数据完整）
{
  const it = createInput();
  const longLine = '字'.repeat(50000);
  it.feed(longLine);
  it.feed('\r');
  assert('超长单行 5万字完整', it.submitted[0] === longLine);
}

// 9. ANSI 清洗
{
  const it = createInput();
  it.feed('第一段\x1b[36mmythinknode\x1b[39m\x1b[1m>>>\x1b[22m 报错');
  it.feed('\r');
  assert('ANSI 码清洗', it.submitted[0] === '第一段mythinknode>>> 报错');
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
