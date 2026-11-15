/** 观察者 / 状态行 契约测试 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { formatStatus } from '../dist/cli/tui/render/status.js';
import { queueRows } from '../dist/cli/tui/layout/geometry.js';

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir.pathname, e);
    if (statSync(p).isDirectory()) out.push(...walk(new URL(`file://${p}/`)));
    else out.push(new URL(`file://${p}`));
  }
  return out;
}

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name} — ${e.message}`); fail++; }
}

console.log('\n=== 1. formatStatus：时间由渲染层现算 ===');
const base = { main: 'Bash', detail: '', startedAt: 1000 };

check('刚进入：0.0s', () => {
  assert.equal(formatStatus(base, 1000), 'Bash (0.0s)');
});

check('2 秒后：秒数递增', () => {
  assert.equal(formatStatus(base, 3000), 'Bash (2.0s)');
});

check('5.5 秒：继续涨（模拟 agent 卡住，观察者照走）', () => {
  assert.equal(formatStatus(base, 6500), 'Bash (5.5s)');
});

check('29 秒：只报时间', () => {
  assert.equal(formatStatus(base, 30000), 'Bash (29.0s)');
});

check('thinking 阶段保留 detail', () => {
  assert.equal(
    formatStatus({ main: 'Thinking', detail: 'analyzing', startedAt: 0 }, 1500),
    'Thinking (1.5s) · analyzing',
  );
});

console.log('\n=== 2. 不得出现「可能卡住 / 仍在进行」这类猜测 ===');

check('长时间不变也不贴「可能卡住」', () => {
  const t = formatStatus(base, 600_000);    // 10 分钟
  assert.ok(!/卡住|无变化|仍在进行/.test(t), t);
  assert.equal(t, 'Bash (599.0s)');
});

check('源码里不再有硬编码阈值策略', () => {
  const src = readFileSync(new URL('../src/cli/tui/render/status.tsx', import.meta.url), 'utf8');
  assert.ok(!/SLOW_HINT_MS|STUCK_HINT_MS/.test(src), '仍有阈值常量');
  assert.ok(!/可能卡住|仍在进行/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')),
    '仍有提示文案（注释除外）');
});

console.log('\n=== 3. 重绘频率 ===');

check('重绘周期 = 100ms（0.1 秒心跳）', () => {
  const src = readFileSync(new URL('../src/cli/tui/render/status.tsx', import.meta.url), 'utf8');
  const m = src.match(/const TICK_MS = ([\d_]+)/);
  assert.ok(m, '未找到 TICK_MS');
  assert.equal(Number(m[1].replace(/_/g, '')), 100, `实际 ${m[1]}`);
});

check('秒数精度为 1 位小数（与 1fps 匹配）', () => {
  const src = readFileSync(new URL('../src/cli/tui/render/status.tsx', import.meta.url), 'utf8');
  assert.ok(/toFixed\(1\)/.test(src));
});

console.log('\n=== 4. queueRows：托盘高度唯一来源 ===');

check('空队列 → 0 行（不渲染）', () => {
  assert.equal(queueRows(0), 0);
});

check('1~3 条 → 标题 + 各条 = 2~4 行', () => {
  assert.equal(queueRows(1), 2);
  assert.equal(queueRows(2), 3);
  assert.equal(queueRows(3), 4);
});

check('4 条 → 标题 + 3 条 + 「还有 N 条」= 5 行', () => {
  assert.equal(queueRows(4), 5);
  assert.equal(queueRows(10), 5);
});

check('★ 与 QUEUE_VISIBLE_ITEMS 保持一致', () => {
  const src = readFileSync(new URL('../src/cli/tui/layout/limits.ts', import.meta.url), 'utf8');
  const m = src.match(/QUEUE_VISIBLE_ITEMS = (\d+)/);
  assert.ok(m, '未找到常量');
  const n = Number(m[1]);
  assert.equal(queueRows(n), 1 + n, '正好 n 条时不应出现「还有」行');
  assert.equal(queueRows(n + 1), 1 + n + 1, 'n+1 条时应多一行「还有」');
});

console.log('\n=== 5. 输入框配色 ===');

check('运行中边框颜色与空闲一致（不再变灰）', () => {
  const src = readFileSync(new URL('../src/cli/tui/SessionApp.tsx', import.meta.url), 'utf8');
  assert.ok(!/running \? colors\.gray : colors\.accent/.test(src),
    '仍有 running 分支的颜色差异');
  assert.ok(/const borderColor = colors\.accent/.test(src), '找不到固定边框颜色');
});

console.log('\n=== 6. 渲染层次：状态行 → 托盘 → 输入框 ===');

check('SessionApp 渲染顺序为 状态行 / 托盘 / 输入框', () => {
  const src = readFileSync(new URL('../src/cli/tui/SessionApp.tsx', import.meta.url), 'utf8');
  const iStatus = src.indexOf('<ThinkingStatus');
  const iTray = src.indexOf('<QueueTray');
  const iInput = src.indexOf('<InputBox');
  assert.ok(iStatus > 0 && iTray > 0 && iInput > 0, '找不到三个组件');
  assert.ok(iStatus < iTray, `状态行(${iStatus}) 应在托盘(${iTray}) 之前`);
  assert.ok(iTray < iInput, `托盘(${iTray}) 应在输入框(${iInput}) 之前`);
});

check('输入框后无其它区块（托盘不会再被渲染到下方）', () => {
  const src = readFileSync(new URL('../src/cli/tui/SessionApp.tsx', import.meta.url), 'utf8');
  const iInput = src.indexOf('<InputBox');
  const tail = src.slice(iInput);
  assert.ok(!/<QueueTray/.test(tail), '输入框之后仍出现 QueueTray');
});

console.log('\n=== 7. 一轮结束必须复位快照（心跳从几百秒开始的根因）===');

check('resetPhase() 在 agent_def 里有定义', () => {
  const src = readFileSync(new URL('../dist/agent/agent_def.js', import.meta.url), 'utf8');
  assert.ok(/resetPhase/.test(src), '找不到 resetPhase');
});

check('★ resetPhase() 有真实调用点（曾经只有定义、零调用 → 死代码）', () => {
  const root = new URL('../src/', import.meta.url);
  const hits = [];
  for (const f of walk(root)) {
    if (!f.pathname.endsWith('.ts')) continue;
    const src = stripComments(readFileSync(f, 'utf8'));
    if (/resetPhase\?\.\(\)|resetPhase\(\)/.test(src)) hits.push(f.pathname);
  }
  // 排除定义本身，必须至少有一个调用点
  const callers = hits.filter(h => !h.endsWith('agent_def.ts'));
  assert.ok(callers.length > 0, 'resetPhase 只有定义没有调用 → 快照永不复位');
});

check('复位发生在每轮 finally 里（异常路径也覆盖）', () => {
  const src = readFileSync(new URL('../src/Mythinknode.ts', import.meta.url), 'utf8');
  const iFinally = src.indexOf('} finally {');
  assert.ok(iFinally > 0, '找不到 finally');
  const tail = src.slice(iFinally, src.indexOf('while (true)', iFinally) > 0 ? undefined : undefined);
  assert.ok(/resetPhase\b/.test(src.slice(iFinally, iFinally + 2000)),
    'finally 块里没有 resetPhase');
});

console.log('\n=== 8. 用户操作不得打断心跳渲染 ===');

check('★ store 里没有 UI 触发的 status 清空（提交/出队/等待输入都不许清）', () => {
  const src = readFileSync(new URL('../src/cli/tui/store.ts', import.meta.url), 'utf8');
  const body = stripComments(src);
  // EMPTY 初始化里的 `status: null` 是声明，不算「UI 触发清空」
  const hits = body.match(/status:\s*null/g) ?? [];
  assert.equal(hits.length, 1,
    `除了 EMPTY 初始化的那一处，不该再有；实际 ${hits.length} 处`);
  assert.ok(/^export interface TuiState/m.test(body) || /status: null,/.test(body));
});

check('★ 只有 startRender 的 cleanup 有权清 status（一轮真正结束）', () => {
  const src = readFileSync(new URL('../src/cli/tui/session.tsx', import.meta.url), 'utf8');
  assert.ok(/store\.setStatus\(null\)/.test(src), 'cleanup 里缺少 setStatus(null)');
});

console.log('\n=== 9. 快照契约（时间语义归观察者）===');
const { idleState } = await import('../dist/agent/runtime_state.js');

check('快照不含 elapsed / duration 这类时长字段', () => {
  const keys = Object.keys(idleState());
  const timeKeys = keys.filter(k => /elapsed|duration|took/i.test(k));
  assert.deepEqual(timeKeys, [], `不该出现: ${timeKeys}`);
  assert.equal(typeof idleState().phaseStartedAt, 'number');
});

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
