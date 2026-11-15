/**
 * 异步工具执行器（src/tools/exec/run.ts）回归测试
 *
 * 核心目的：锁住「执行期间事件循环不被阻塞」这条不变量。
 * 改前 BashTool 用 execSync，sleep 期间 setInterval 一次都不触发
 * （心跳冻结 / 键盘失灵 / 中断失效 / 30s 超时变假护栏）。
 */
import assert from 'node:assert';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { runCommand } from '../dist/tools/exec/run.js';
import { BashTool } from '../dist/tools/exec/BashTool/BashTool.js';

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✅ ${name}`); pass++; })
    .catch((e) => { console.log(`  ❌ ${name} — ${e.message}`); fail++; });
}

const ctx = (over = {}) => ({
  options: { tools: [], verbose: false, isNonInteractiveSession: false, mainLoopModel: 'default', debug: false },
  abortController: new AbortController(),
  ...over,
});

console.log('\n=== 1. 基本执行 ===');

await check('退出码 0 + stdout 正确', async () => {
  const r = await runCommand('echo hello');
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'hello');
  assert.equal(r.signal, null);
  assert.equal(r.timedOut, false);
});

await check('非零退出码被如实返回（不抛异常）', async () => {
  const r = await runCommand('exit 3');
  assert.equal(r.code, 3);
});

await check('stderr 单独收集', async () => {
  const r = await runCommand('echo oops 1>&2; exit 1');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /oops/);
  assert.equal(r.stdout.trim(), '');
});

console.log('\n=== 2. ★ 事件循环不被阻塞（本次修复的核心） ===');

await check('sleep 1 期间 setInterval(50) 至少触发 10 次', async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 50);
  const started = Date.now();
  const r = await runCommand('sleep 1');
  const elapsed = Date.now() - started;
  clearInterval(timer);
  assert.equal(r.code, 0);
  assert.ok(elapsed >= 900, `耗时应 ≥900ms，实际 ${elapsed}ms`);
  // execSync 时代这里是 0：主线程被占死，定时器一个都不触发
  assert.ok(ticks >= 10, `期间定时器只触发 ${ticks} 次（<10 说明主线程被阻塞）`);
});

await check('sleep 1 期间两个并发 runCommand 并行完成', async () => {
  const started = Date.now();
  const [a, b] = await Promise.all([runCommand('sleep 1; echo a'), runCommand('sleep 1; echo b')]);
  const elapsed = Date.now() - started;
  assert.equal(a.stdout.trim(), 'a');
  assert.equal(b.stdout.trim(), 'b');
  // 串行需要 2000ms，并行约 1000ms
  assert.ok(elapsed < 1800, `两个 sleep 1 应并行（实际 ${elapsed}ms）`);
});

console.log('\n=== 3. 超时 ===');

await check('timeoutMs 生效并标记 timedOut', async () => {
  const started = Date.now();
  const r = await runCommand('sleep 10', { timeoutMs: 300 });
  const elapsed = Date.now() - started;
  assert.equal(r.timedOut, true);
  assert.ok(r.signal, '应带 kill 信号');
  assert.ok(elapsed < 3000, `应在超时后很快返回，实际 ${elapsed}ms`);
});

await check('超时后子进程真的被终止（不是只停止等待）', async () => {
  // 命令把自己的 pid 写进文件，超时后检查进程是否还在
  const marker = `/tmp/mtn-async-${Date.now()}.pid`;
  const r = await runCommand(`echo $$ > ${marker}; sleep 10`, { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  await new Promise(r2 => setTimeout(r2, 400));
  const { execFileSync } = await import('node:child_process');
  const pid = execFileSync('cat', [marker]).toString().trim();
  let alive = true;
  try { process.kill(Number(pid), 0); } catch { alive = false; }
  assert.equal(alive, false, `子进程 ${pid} 应已被杀`);
});

console.log('\n=== 4. 中断 signal ===');

await check('AbortSignal abort → 快速返回并带 kill 信号', async () => {
  const ac = new AbortController();
  const started = Date.now();
  const p = runCommand('sleep 10', { signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  const r = await p;
  const elapsed = Date.now() - started;
  assert.ok(r.signal, '应带 kill 信号');
  assert.ok(elapsed < 3000, `abort 后应很快返回，实际 ${elapsed}ms`);
});

await check('已 abort 的 signal 立刻不执行长命令', async () => {
  const ac = new AbortController();
  ac.abort();
  const started = Date.now();
  const r = await runCommand('sleep 10', { signal: ac.signal });
  assert.ok(Date.now() - started < 3000);
  assert.ok(r.signal);
});

console.log('\n=== 5. 输出完整性 ===');

await check('maxBuffer 超限被截断并标记', async () => {
  const r = await runCommand('printf "aaaaaaaaaa"; printf "bbbbbbbbbb"', { maxBuffer: 12 });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length <= 12, `实际长度 ${r.stdout.length}`);
});

await check('大输出不截断时内容完整', async () => {
  const r = await runCommand('for i in $(seq 1 200); do echo "line$i"; done');
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim().split('\n').length, 200);
  assert.equal(r.truncated, false);
});

await check('中文跨 chunk 不乱码（StringDecoder）', async () => {
  // 分多次写出，每次之间 sleep，迫使 data 事件产生多个 chunk
  const r = await runCommand(
    'for i in 1 2 3 4 5 6 7 8; do printf "中文测试内容"; sleep 0.02; done',
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '中文测试内容'.repeat(8), `实际: ${JSON.stringify(r.stdout.slice(0, 40))}`);
});

await check('cwd 生效', async () => {
  // macOS 上 /tmp 是 /private/tmp 的软链接，pwd 会给出真实路径 → 用 realpath 对齐
  const r = await runCommand('pwd', { cwd: '/tmp' });
  assert.equal(r.stdout.trim(), realpathSync('/tmp'));
});

console.log('\n=== 6. BashTool 集成（文案结构不变）===');

await check('成功：无输出时给占位提示', async () => {
  const r = await BashTool.call({ command: 'true' }, ctx());
  assert.equal(r.data, '(completed successfully, no output)');
});

await check('成功：有输出时原样返回', async () => {
  const r = await BashTool.call({ command: 'echo hi' }, ctx());
  assert.equal(r.data.trim(), 'hi');
});

await check('失败：Exit: N + Stdout/Stderr 结构', async () => {
  const r = await BashTool.call({ command: 'echo out; echo err 1>&2; exit 2' }, ctx());
  assert.match(r.data, /^Exit: 2/);
  assert.match(r.data, /Stdout:/);
  assert.match(r.data, /Stderr:/);
  assert.match(r.data, /err/);
});

await check('超时：Killed by signal + 明确毫秒数', async () => {
  const r = await BashTool.call({ command: 'sleep 10', timeout: 300 }, ctx());
  assert.match(r.data, /Killed by signal SIGTERM/);
  assert.match(r.data, /timed out after 300ms/);
});

await check('危险命令仍被拦截（没被异步化改坏）', async () => {
  const r = await BashTool.call({ command: 'rm -rf /' }, ctx());
  assert.match(r.data, /^BLOCKED: Dangerous command/);
});

console.log('\n=== 7. 源码不变量 ===');
const root = new URL('../', import.meta.url);

/**
 * 剥掉行注释与块注释 —— 教训 L11：结构断言前必须先剥注释，
 * 否则解释性注释里出现的被禁标识（如 "不用 execSync 了"）会造成假失败。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

await check('Bash/Glob/Grep 不再使用 execSync（已剥注释）', () => {
  for (const f of [
    'src/tools/exec/BashTool/BashTool.ts',
    'src/tools/file/GlobTool/GlobTool.ts',
    'src/tools/file/GrepTool/GrepTool.ts',
  ]) {
    const src = stripComments(readFileSync(new URL(f, root), 'utf-8'));
    assert.ok(!/\bexecSync\b/.test(src), `${f} 仍在使用 execSync`);
  }
});

await check('src 全仓仅注释提及 execSync（无真实调用）', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
        const src = stripComments(readFileSync(p, 'utf-8'));
        if (/\bexecSync\s*\(/.test(src)) hits.push(p.pathname);
      }
    }
  };
  walk(new URL('src/', root));
  assert.deepEqual(hits, [], `仍有真实 execSync 调用: ${hits.join(', ')}`);
});

await check('三个工具都接入了中断 signal', () => {
  for (const f of [
    'src/tools/exec/BashTool/BashTool.ts',
    'src/tools/file/GlobTool/GlobTool.ts',
    'src/tools/file/GrepTool/GrepTool.ts',
  ]) {
    const src = readFileSync(new URL(f, root), 'utf-8');
    assert.ok(/currentSignal\(\)/.test(src), `${f} 未接 currentSignal()`);
  }
});

await check('外层护栏按工具自身 timeout 放大', async () => {
  const src = readFileSync(new URL('src/query_loop.ts', root), 'utf-8');
  assert.ok(/declared > 0 \? declared \+ 5000 : 0/.test(src), '未按声明 timeout 放大护栏');
});

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
