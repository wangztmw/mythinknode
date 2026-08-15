/**
 * 输入状态机 — 纯逻辑，零 I/O。
 * 从 input-buffer.ts 的 stdin 处理器提取出 chars/cursor/inPaste 状态迁移 + 提交检测，
 * 供 input-buffer 驱动 + test-suite 直测。渲染（echo/redraw）由驱动层负责。
 */
import { cleanInput } from './input-geometry.js';

export interface InputModel {
  chars: string[];
  cursor: number;
  inPaste: boolean;
}

export interface InputEffect {
  exit: boolean;                       // Ctrl+C
  submit: string | null;               // 提交的清洗后文本（Enter / Ctrl+D）
  newline: boolean;                    // 提交来自 Enter（应写 \n）；Ctrl+D 为 false
  edit: 'append' | 'redraw' | null;    // 本次 chunk 改变了内容时，应做的重绘方式
}

export function createModel(): InputModel {
  return { chars: [], cursor: 0, inPaste: false };
}

/** 原地更新 model，返回效果。逐分支复刻 input-buffer 的原 stdin 处理器。 */
export function applyChunk(model: InputModel, chunk: string): InputEffect {
  const effect: InputEffect = { exit: false, submit: null, newline: false, edit: null };

  // Ctrl+C (0x03) 退出
  if (chunk === '\x03') { effect.exit = true; return effect; }
  // bracketed paste 开始标记
  if (chunk.includes('\x1b[200~')) {
    model.inPaste = true;
    chunk = chunk.replace(/\x1b\[200~/g, '');
    if (chunk === '') return effect;
  }
  // bracketed paste 结束标记
  if (chunk.includes('\x1b[201~')) {
    model.inPaste = false;
    chunk = chunk.replace(/\x1b\[201~/g, '');
    if (chunk === '') return effect;
  }
  // Ctrl+D (0x04) 立即提交（不换行）
  if (chunk === '\x04') { effect.submit = cleanInput(model.chars.join('').trim()); return effect; }
  // 回车提交（仅非粘贴模式）
  if (!model.inPaste && (chunk === '\r' || chunk === '\n')) {
    effect.submit = cleanInput(model.chars.join('').trim());
    effect.newline = true;
    return effect;
  }
  // 方向键左/右
  if (chunk === '\x1b[D') { if (model.cursor > 0) { model.cursor--; effect.edit = 'redraw'; } return effect; }
  if (chunk === '\x1b[C') { if (model.cursor < model.chars.length) { model.cursor++; effect.edit = 'redraw'; } return effect; }
  // Home / End
  if (chunk === '\x1b[H' || chunk === '\x1b[1~') { model.cursor = 0; effect.edit = 'redraw'; return effect; }
  if (chunk === '\x1b[F' || chunk === '\x1b[4~') { model.cursor = model.chars.length; effect.edit = 'redraw'; return effect; }
  // 退格
  if (chunk === '\x7f' || chunk === '\x08') {
    if (model.cursor > 0) { model.chars.splice(model.cursor - 1, 1); model.cursor--; effect.edit = 'redraw'; }
    return effect;
  }
  // Delete
  if (chunk === '\x1b[3~') {
    if (model.cursor < model.chars.length) { model.chars.splice(model.cursor, 1); effect.edit = 'redraw'; }
    return effect;
  }
  // 普通输入
  const text = chunk.replace(/\r/g, '\n');
  const newChars = Array.from(text);
  if (model.cursor === model.chars.length) {
    model.chars.push(...newChars);
    model.cursor = model.chars.length;
    effect.edit = 'append';
  } else {
    model.chars.splice(model.cursor, 0, ...newChars);
    model.cursor += newChars.length;
    effect.edit = 'redraw';
  }
  return effect;
}
