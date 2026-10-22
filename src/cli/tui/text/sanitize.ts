/**
 * 输出清洗 — 移除 ANSI / 控制字符，避免工具输出破坏 Ink 动态帧。
 * 保留换行与制表符；`\r` 统一为换行。
 */
const OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const CSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const OTHER_ESC = /\u001B[@-_]/g;
// 保留 \t (0x09) 与 \n (0x0a)
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeOutput(text: string): string {
  return text
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(OTHER_ESC, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CONTROL, '');
}
