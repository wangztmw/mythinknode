// 复现：从终端复制的文本含 ANSI 码，混入输入导致 LLM JSON 崩溃
const dirtyInput = '第一段\x1b[36mmythinknode\x1b[39m\x1b[1m>>>\x1b[22m 报错内容\r\n\x1b[2m(59 lines total)\x1b[22m';

// 清洗函数：去掉 ANSI 转义序列 + 控制字符
function cleanInput(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')  // ANSI CSI 序列
    .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC 序列
    .replace(/\r/g, '')                         // 回车符
    .replace(/\x1b[()][A-Z0-9]/g, '');          // 字符集切换
}

console.log('=== 清洗前（含 ANSI 码）===');
console.log(JSON.stringify(dirtyInput));
console.log('=== 清洗后 ===');
console.log(JSON.stringify(cleanInput(dirtyInput)));
console.log('=== 验证：清洗后无残留 \x1b ===');
console.log(cleanInput(dirtyInput).includes('\x1b') ? '❌ 仍有残留' : '✅ 干净');
