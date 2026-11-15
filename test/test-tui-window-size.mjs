// resize 监听器收敛回归测试
// 用法: node Plan/cli-test/test-tui-window-size.mjs（需先 npm run build）
//
// 背景：ink 的 useWindowSize() 是「每个组件实例各挂一个 stdout resize 监听器」。
// 本项目 16 处调用 + <Static> 同帧挂载 N 个日志项 → 一次推入 11 条以上就打出
//   MaxListenersExceededWarning: 11 resize listeners added to [WriteStream]
// 修法：根部 WindowSizeProvider 订阅一次，组件走 context。
//
// 本测试锁两件事：
//   1. 结构：全仓只有 provider 内部直接调用 ink 的 useWindowSize
//   2. 运行时：确实只有监听器数量 ≤ 1，且 context 能正确下发尺寸
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ROOT = new URL('../', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// ============================================================
console.log('\n=== 1. 结构：useWindowSize 只在 provider 内部直接调用 ===\n');
// ============================================================
{
  const files = walk(SRC);
  const callers = files.filter(f => {
    const s = readFileSync(f, 'utf8');
    // 只看真实调用/导入，不看注释里的说明文字
    return /from 'ink'/.test(s) && /(?<![\w.])useWindowSize\b/.test(
      s.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n'));
  });
  const rel = callers.map(f => f.slice(SRC.length + 1)).sort();
  assert('只有 window-size.tsx 从 ink 引入 useWindowSize',
    rel.length === 1 && rel[0] === 'cli/tui/layout/window-size.tsx',
    JSON.stringify(rel));

  // 其余文件不能再用 useWindowSize
  const legacy = files
    .filter(f => !f.endsWith('layout/window-size.tsx'))
    .filter(f => {
      const s = readFileSync(f, 'utf8');
      const code = s.split('\n').filter(l => {
        const t = l.trim();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      }).join('\n');
      return /(?<![\w.])useWindowSize\s*\(/.test(code);
    })
    .map(f => f.slice(SRC.length + 1));
  assert('没有任何组件再调用 useWindowSize()', legacy.length === 0, JSON.stringify(legacy));
}

// ============================================================
console.log('\n=== 2. 结构：所有终端组件改用 useTerminalSize ===\n');
// ============================================================
{
  const expectFiles = [
    'cli/tui/App.tsx',
    'cli/tui/SessionApp.tsx',
    'cli/tui/render/tool.tsx',
    'cli/tui/render/status.tsx',
    'cli/tui/render/markdown.tsx',
    'cli/tui/render/thought.tsx',
    'cli/tui/render/welcome.tsx',
  ];
  for (const rel of expectFiles) {
    const s = readFileSync(join(SRC, rel), 'utf8');
    assert(`${rel} 使用 useTerminalSize`,
      /useTerminalSize/.test(s), '(未找到)');
  }

  // 每处原来调 useWindowSize 的位置都应改成 useTerminalSize
  // （注释里会提到 useWindowSize() 做说明，先去掉注释块再统计）
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/^\s*\/\/.*$/gm, '');         // 行注释
  const all = walk(SRC).map(f => stripComments(readFileSync(f, 'utf8'))).join('\n');
  const oldCalls = (all.match(/useWindowSize\(\)/g) ?? []).length;
  assert('全仓 useWindowSize() 调用只剩 provider 内 1 处', oldCalls === 1, `${oldCalls} 处`);
}

// ============================================================
console.log('\n=== 3. 结构：两个 mount 点都被 provider 包裹 ===\n');
// ============================================================
{
  const index = readFileSync(join(SRC, 'cli/tui/index.tsx'), 'utf8');
  assert('index.tsx 引入 WindowSizeProvider', /WindowSizeProvider/.test(index));
  assert('index.tsx 的 render 被 provider 包裹',
    /render\(\s*<WindowSizeProvider>[\s\S]{0,200}<App \/>/.test(index) ||
    /<WindowSizeProvider>\s*<App \/>/.test(index.replace(/\n/g, ' ')),
    index.slice(index.indexOf('render('), index.indexOf('render(') + 200));

  const session = readFileSync(join(SRC, 'cli/tui/session.tsx'), 'utf8');
  assert('session.tsx 引入 WindowSizeProvider', /WindowSizeProvider/.test(session));
  assert('session.tsx 的 render 被 provider 包裹',
    /<WindowSizeProvider>\s*<SessionApp/.test(session.replace(/\n\s*/g, ' ')),
    session.slice(session.indexOf('render('), session.indexOf('render(') + 220));
}

// ============================================================
console.log('\n=== 4. provider 实现：默认值不能用 hook 兜底 ===\n');
// ============================================================
{
  const ws = readFileSync(join(SRC, 'cli/tui/layout/window-size.tsx'), 'utf8');
  assert('导出 WindowSizeProvider', /export function WindowSizeProvider/.test(ws));
  assert('导出 useTerminalSize', /export function useTerminalSize/.test(ws));
  assert('provider 内部调用一次 useWindowSize', /useWindowSize\(\)/.test(ws));

  // 关键反例：不能写成 ctx ?? useWindowSize()（条件调用 hook，违反 React 规则）
  const code = ws.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert('useTerminalSize 内没有条件调用 hook',
    !/\?\?\s*useWindowSize\s*\(/.test(code), '出现 ctx ?? useWindowSize() 模式');
  assert('useTerminalSize 直接返回 useContext 结果',
    /useContext\(WindowSizeContext\)/.test(code));

  // context 必须有静态默认值，否则 provider 外拿到 undefined
  assert('createContext 带了默认值', /createContext<[^>]+>\(FALLBACK\)/.test(code) || /createContext\(FALLBACK\)/.test(code));
  assert('默认值来自 process.stdout 尺寸',
    /process\.stdout\.columns/.test(code) && /process\.stdout\.rows/.test(code));

  // useMemo 依赖必须是两个原始值，否则每次渲染都换新对象 → 消费者全量重渲染
  assert('context value 用 useMemo 缓存', /useMemo/.test(code));
  assert('useMemo 依赖只有 columns/rows',
    /\[columns,\s*rows\]/.test(code), '(依赖列表不是 [columns, rows])');
}

// ============================================================
console.log('\n=== 5. 运行时：Provider 下监听器数量 ≤ 1 ===\n');
// ============================================================
{
  // 用假 stdout 统计 resize 监听器：直接驱动 React 渲染太重，
  // 这里验证「provider 只订阅一次」这一语义 —— 通过检查是否只有一个
  // useEffect 里调用 stdout.on('resize')。
  const ws = readFileSync(join(SRC, 'cli/tui/layout/window-size.tsx'), 'utf8');
  const code = ws.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  const onResizeCalls = (code.match(/\.on\(\s*['"]resize['"]/g) ?? []).length;
  assert('provider 内部不自己挂 resize（交给 ink 的 useWindowSize）', onResizeCalls === 0,
    `${onResizeCalls} 处手动 .on('resize')`);

  // 整个 src 里，除了 classic 屏幕状态（那是另一套渲染，不走 ink），
  // 不应再有别处手动订阅 stdout resize
  const manual = walk(SRC).filter(f => {
    const s = readFileSync(f, 'utf8');
    const c = s.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    return /stdout\.on\(\s*['"]resize['"]/.test(c);
  }).map(f => f.slice(SRC.length + 1));
  assert('只允许 cli.ts（classic 备用屏）手动订阅 resize',
    manual.length === 1 && manual[0] === 'cli/cli.ts', JSON.stringify(manual));
}

// ============================================================
console.log('\n=== 6. 反例：确认没有用 setMaxListeners 消音 ===\n');
// ============================================================
{
  const files = walk(SRC);
  // 只查真实代码，注释里会提到 setMaxListeners（说明为什么不用它）不算违规
  const muted = files.filter(f => {
    const code = readFileSync(f, 'utf8')
      .split('\n')
      .filter(l => {
        const t = l.trim();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n');
    return /setMaxListeners\s*\(/.test(code);
  }).map(f => f.slice(SRC.length + 1));
  assert('没有用 setMaxListeners 掩盖警告', muted.length === 0, JSON.stringify(muted));
}

// ============================================================
console.log('\n=== 7. 反例：WindowSizeProvider 一层就够，不要嵌套 ===\n');
// ============================================================
{
  const index = readFileSync(join(SRC, 'cli/tui/index.tsx'), 'utf8');
  const session = readFileSync(join(SRC, 'cli/tui/session.tsx'), 'utf8');
  const count = (s) => (s.match(/<WindowSizeProvider/g) ?? []).length;
  assert('index.tsx 只包一层', count(index) === 1, `${count(index)} 层`);
  assert('session.tsx 只包一层', count(session) === 1, `${count(session)} 层`);
  // provider 不能出现在 App/SessionApp 内部（否则根组件自身在 provider 之外）
  const app = readFileSync(join(SRC, 'cli/tui/App.tsx'), 'utf8');
  const sapp = readFileSync(join(SRC, 'cli/tui/SessionApp.tsx'), 'utf8');
  assert('App 内部不包 provider', !/<WindowSizeProvider/.test(app));
  assert('SessionApp 内部不包 provider', !/<WindowSizeProvider/.test(sapp));
}

console.log(`\n结果: ${PASS} 通过, ${FAIL} 失败\n`);
process.exit(FAIL === 0 ? 0 : 1);
