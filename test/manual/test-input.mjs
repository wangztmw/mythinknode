// 输入边界逻辑测试 —— 复现"粘贴含空行的多行文本被切碎"问题
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

let resolveLine = null;
let lineBuffer = [];
let settleTimer = null;
let results = [];

// 两种 settle 逻辑切换：USE_EMPTY_SETTLE=true 是当前有 bug 的版本
const USE_EMPTY_SETTLE = process.env.USE_EMPTY_SETTLE === '1';

const settle = () => {
  if (!resolveLine) return;
  const text = lineBuffer.join('\n').trim();
  lineBuffer = [];
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  const resolve = resolveLine;
  resolveLine = null;
  results.push(text);
  resolve(text);
};

rl.on('line', (line) => {
  if (!resolveLine) return;
  lineBuffer.push(line);
  if (USE_EMPTY_SETTLE && line.trim() === '') { settle(); return; }  // ← bug: 空行立即 settle
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, 150);
});

function readLine() {
  return new Promise(resolve => {
    resolveLine = resolve;
    lineBuffer = [];
  });
}

// 模拟：用户粘贴一段含空行的多行文本（比如从终端复制的报错日志）
(async () => {
  const p1 = readLine();
  const r1 = await p1;
  console.log('第1次 resolve 内容行数:', r1.split('\n').length, '| 首行:', JSON.stringify(r1.split('\n')[0].slice(0,30)));
  console.log('第1次 resolve 完整内容:', JSON.stringify(r1.slice(0, 100)));
  
  // 如果还有残留（被空行切碎的剩余部分）
  const p2 = readLine();
  const r2 = await p2;
  console.log('第2次 resolve:', JSON.stringify(r2.slice(0, 80)));
  process.exit(0);
})();
