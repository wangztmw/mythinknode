// ScreenBuffer 回归测试（方向 B 第二步：scrollback + viewport + flush）
// 用法: node Plan/cli-test/test-screen-buffer.mjs（需先 npm run build）
import { ScreenBuffer } from '../../dist/cli/render/screen-buffer.js';

let PASS = 0, FAIL = 0;
function assert(name, cond) { if (cond) { PASS++; console.log(`  ✅ ${name}`); } else { FAIL++; console.log(`  ❌ ${name}`); } }

console.log('\n=== ScreenBuffer 回归 ===\n');

// 1. 输出进 scrollback + viewport（内容顶对齐）
{
  const sb = new ScreenBuffer(3, 10);
  sb.writeOutput('aaa\nbbb');
  const snap = sb.snapshot();
  assert('内容顶对齐：aaa/bbb/空', snap[0] === 'aaa' && snap[1] === 'bbb' && snap[2] === '');
}

// 2. 内容超屏：viewport 跟随底部
{
  const sb = new ScreenBuffer(3, 10);
  sb.writeOutput('1\n2\n3\n4\n5');  // 5 行 > 3 行窗口
  const snap = sb.snapshot();
  assert('超屏后显示底部 3 行', snap[0] === '3' && snap[1] === '4' && snap[2] === '5');
}

// 3. scrollBy 回滚
{
  const sb = new ScreenBuffer(3, 10);
  sb.writeOutput('1\n2\n3\n4\n5');
  sb.scrollBy(2);
  const snap = sb.snapshot();
  assert('回滚 2 行后显示 1/2/3', snap[0] === '1' && snap[1] === '2' && snap[2] === '3');
}

// 4. 回滚后写新输出：不跟随（停在回滚位置）
{
  const sb = new ScreenBuffer(3, 10);
  sb.writeOutput('1\n2\n3\n4\n5');
  sb.scrollBy(2);
  sb.writeOutput('6');
  assert('回滚状态下新输出不打断回滚', !sb.atBottom);
  const snap = sb.snapshot();
  assert('回滚状态 viewport 不变', snap[0] === '1' && snap[1] === '2' && snap[2] === '3');
}

// 5. flush 只在有变化时输出
{
  let out = '';
  const sb = new ScreenBuffer(3, 10, (s) => { out += s; });
  sb.writeOutput('1\n2\n3');
  sb.flush();
  out = '';
  sb.flush();  // 无变化
  assert('无变化时 flush 不输出', out === '');
  sb.writeOutput('4');  // 滚动
  sb.flush();
  assert('滚动后 flush 有输出', out.length > 0);
}

// 6. ANSI bold 输出：解析成样式，不把 \x1b 当字面量写进网格
{
  const sb = new ScreenBuffer(3, 20);
  sb.writeOutput('\x1b[1mHead\x1b[22m body');
  const snap = sb.snapshot();
  assert('ANSI bold 输出：snapshot 不含 \\x1b', !snap[0].includes('\x1b'));
  assert('ANSI bold 输出：文本正确', snap[0] === 'Head body');
}

// 7. 自实现 scrollback：输入块激活时回滚，指示行出现在输入块上方
{
  const sb = new ScreenBuffer(6, 20);
  sb.setPrompt('P> ');
  sb.setInput('', { line: 0, col: 3 });   // 输入块激活（prompt 贴底）
  sb.writeOutput('1\n2\n3\n4\n5\n6\n7\n8');  // 8 行输出
  let snap = sb.snapshot();
  assert('滚动前：输出贴输入块上方', snap[0] === '4' && snap[4] === '8' && snap[5] === 'P>');

  sb.scrollBy(3);   // 回滚 3 行
  snap = sb.snapshot();
  assert('回滚后：输出上移', snap[0] === '1' && snap[3] === '4');
  assert('回滚后：指示行在输入块上方', snap[4].includes('PgDn回底') && snap[5] === 'P>');

  sb.scrollToBottom();
  snap = sb.snapshot();
  assert('回到底：指示行消失', snap[0] === '4' && !snap.some((r) => r.includes('PgDn回底')) && snap[5] === 'P>');
}

// 8. 回滚到最顶：maxOffset 受输入块+指示行约束
{
  const sb = new ScreenBuffer(6, 20);
  sb.setPrompt('P> ');
  sb.setInput('', { line: 0, col: 3 });
  sb.writeOutput('1\n2\n3\n4\n5\n6\n7\n8');
  sb.scrollBy(100);  // 超过最大回滚
  const snap = sb.snapshot();
  assert('回滚到最顶：显示第 1 行', snap[0] === '1');
}

// 9. commitInput：提交后输入行进 scrollback（原生屏语义），输入块隐藏
{
  const sb = new ScreenBuffer(6, 20);
  sb.setPrompt('P> ');
  sb.setInput('hi', { line: 0, col: 5 });
  sb.commitInput('hi');
  const snap = sb.snapshot();
  assert('commitInput：输入行进历史', snap[0] === 'P> hi');
  assert('commitInput：输入块隐藏', snap[5] === '');
}

// 10. resize：尺寸变化后网格更新 + 内容重绘
{
  const sb = new ScreenBuffer(6, 20);
  sb.writeOutput('a\nb');
  sb.resize(4, 10);
  const snap = sb.snapshot();
  assert('resize：rows/cols 更新', sb.rows === 4 && sb.cols === 10);
  assert('resize：内容在新尺寸网格重绘', snap[0] === 'a' && snap[1] === 'b' && snap.length === 4);
}

// 11. resize 重折行：缩窄后旧内容按新宽度重新折行，不截断（「内容消失」bug 的回归）
{
  const sb = new ScreenBuffer(6, 30);
  sb.writeOutput('这是一段很长的中文内容需要折行显示测试');
  sb.resize(6, 12);
  const snap = sb.snapshot();
  const full = snap.filter((r) => r !== '').join('');
  assert('resize 重折行：内容完整不丢失', full === '这是一段很长的中文内容需要折行显示测试');
  assert('resize 重折行：每行 ≤ 新宽度', snap.every((r) => [...r].reduce((w, c) => w + (/[一-鿿]/.test(c) ? 2 : 1), 0) <= 12));
}

// 12. 光标列钳位：输入铺满行（pending-wrap，col==cols）不发越界列 \x1b[r;cols+1H
//     （否则 Terminal.app 收到越界列会换行/滚动 ——「行末疯狂滚动」的根因）
{
  let out = '';
  const sb = new ScreenBuffer(3, 5, (s) => { out += s; });
  sb.setPrompt('> ');                              // prompt 2 列
  sb.setInput('abc', { line: 0, col: 5 });         // 2 + 3 = 5 = cols，pending-wrap
  sb.flush();
  assert('pending-wrap 光标列不越界（无 \\x1b[1;6H）', !out.includes('\x1b[1;6H'));
  assert('pending-wrap 光标落在末列（\\x1b[1;5H）', out.includes('\x1b[1;5H'));
}

// 13. 光标行钳位：长输入折行超过可见窗 + 光标在窗口之上（Home）不发负行号
{
  let out = '';
  const sb = new ScreenBuffer(6, 20, (s) => { out += s; });
  sb.setPrompt('> ');
  sb.setInput('a\nb\nc\nd\ne\nf\ng\nh', { line: 0, col: 2 });  // 8 行 > 6 行，光标 Home 在行 0
  sb.flush();
  assert('长输入+Home 不发负行号（无 \\x1b[-）', !/\\x1b\[-/.test(out));
}

console.log(`\n=== 结果: ${PASS} 通过, ${FAIL} 失败 ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
