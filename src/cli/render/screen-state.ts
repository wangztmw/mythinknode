/**
 * ScreenState — 单一屏幕模型（最小屏幕状态追踪）。
 *
 * 只追踪几何，不追踪输出历史：
 *   - inputRows：输入块占用的行数（0 = 无输入块在屏）。取代旧 cli.ts 的 renderedLines。
 *   - statusActive：光标是否停在活状态行（末字节 \x1b[K、无 \n 收尾）。
 *
 * 三个不变量：
 *   I1 输入块永远在屏幕最后 N 行 —— 定位只相对屏幕底部（\x1b[{inputRows-1}A），与输出历史无关。
 *   I2 活状态行不悬挂 —— 写多行输出 / prompt 前先 \n 收尾，杜绝「\r ● Thinking… 插进结果和 prompt 之间」。
 *   I3 单写路径 —— CLI 层所有 process.stdout.write 都经 emit()。
 */
import { displayWidth, wrapLine } from './term-wrap.js';
import { contentLines as geomContentLines, cursorPos as geomCursorPos, foldInput as geomFoldInput } from '../input/input-geometry.js';

export class ScreenState {
  private prompt: string;
  private promptWidth: number;
  private _inputRows = 0;
  private _statusActive = false;
  private _statusLine = '';   // 当前状态行内容，供下次 overwriteStatus 做前缀 diff

  constructor(prompt: string) {
    this.prompt = prompt;
    this.promptWidth = displayWidth(prompt);
  }

  get cols(): number { return process.stdout.columns || 80; }
  get inputRows(): number { return this._inputRows; }

  // ---- 几何（委托 input-geometry，逐字节等价） ----

  contentLines(chars: string[]): number { return geomContentLines(chars, this.cols, this.promptWidth); }
  cursorPos(chars: string[], cursor: number): { line: number; col: number } { return geomCursorPos(chars, cursor, this.cols, this.promptWidth); }
  foldInput(chars: string[], startCol: number = this.promptWidth): string { return geomFoldInput(chars, this.cols, startCol); }

  // ---- 写路径 ----

  /** 唯一 process.stdout.write 咽喉（I3）。 */
  emit(raw: string): void { process.stdout.write(raw); }

  /** 标记活状态行状态。渲染层维护；输入层据此避免 prompt 粘连。 */
  markStatus(active: boolean): void { this._setStatusActive(active); }

  private _setStatusActive(active: boolean): void {
    this._statusActive = active;
    if (!active) this._statusLine = '';  // 状态行收尾后，其内容作废
  }

  // ---- 输入块原语 ----

  printPrompt(): void {
    // I2：若有活状态行悬挂，先收尾，避免 prompt 粘到 thinking 行
    if (this._statusActive) this.emit('\n');
    this.emit(this.prompt);
    this._inputRows = 1;
    this._setStatusActive(false);
  }

  /** 重绘输入块（逐字节复刻旧 redraw()，含两个 >0 守卫） */
  rewriteInput(folded: string, newRows: number, line: number, col: number): void {
    let out = '';
    if (this._inputRows > 1) out += `\x1b[${this._inputRows - 1}A`;
    out += `\r\x1b[J${this.prompt}${folded}`;
    const upToCursor = newRows - 1 - line;
    if (upToCursor > 0) out += `\x1b[${upToCursor}A`;
    out += '\r';
    if (col > 0) out += `\x1b[${col}C`;
    this._inputRows = newRows;
    this._setStatusActive(false);
    this.emit(out);
  }

  /** O(1) 追加 echo（光标在末尾时） */
  appendInput(foldedChunk: string, newRows: number): void {
    this.emit(foldedChunk);
    this._inputRows = newRows;
  }

  /** 提交：写 \n 收尾输入块，inputRows 归 0 */
  submitInput(): void {
    this.emit('\n');
    this._inputRows = 0;
    this._setStatusActive(false);
  }

  // ---- 输出原语 ----

  /** 写一条新状态行（thinking_start）。可前置换行。记录内容供后续 diff。 */
  beginStatus(content: string, leadingNewline: boolean): void {
    this._statusLine = content;
    this._setStatusActive(true);
    this.emit(`${leadingNewline ? '\n' : ''}${content}\x1b[K`);
  }

  /** 覆写活状态行：与上次内容做前缀 diff，只写变化部分（对标 Ink cell-diff，降写频）。 */
  overwriteStatus(content: string): void {
    const prev = this._statusLine;
    this._statusLine = content;
    this._setStatusActive(true);

    // 首次写 → 整行写
    if (prev === '') { this.emit(`\r${content}\x1b[K`); return; }

    // 公共前缀（原始字符；ANSI 码位置稳定）
    let p = 0;
    const min = Math.min(prev.length, content.length);
    while (p < min && prev[p] === content[p]) p++;
    const prefix = prev.slice(0, p);

    // diff 点落在粗体段内（前缀含未闭合粗体）→ 回退整行写，避免 SGR 错乱
    if (this._endsInBold(prefix)) { this.emit(`\r${content}\x1b[K`); return; }

    // 新行是旧行延长 → 光标已在末尾，直接写后缀
    if (p === prev.length) { this.emit(content.slice(p)); return; }

    // 通用 diff：回到前缀列 + 写新后缀 +（变短时）清残留
    const prefixW = displayWidth(prefix);
    const prevW = displayWidth(prev);
    const newW = displayWidth(content);
    let out = `\r\x1b[${prefixW}C${content.slice(p)}`;
    if (newW < prevW) out += '\x1b[K';
    this.emit(out);
  }

  /** 前缀的粗体是否未闭合（即 diff 点落在 \x1b[1m… 内） */
  private _endsInBold(prefix: string): boolean {
    let bold = false;
    for (let i = 0; i < prefix.length; i++) {
      if (prefix[i] === '\x1b' && prefix[i + 1] === '[') {
        const m = /^\x1b\[([0-9;]*)m/.exec(prefix.slice(i));
        if (m) {
          const codes = m[1].split(';');
          if (codes.includes('1')) bold = true;
          else if (codes.includes('22') || codes.includes('0')) bold = false;
          i += m[0].length - 1;
        }
      }
    }
    return bold;
  }

  /** 写多行文本：逐行 wrapLine 折行，保证无超长行（治本：超长行会触发 Terminal SwiftUI 布局递归崩溃） */
  writeLines(text: string): void {
    // I2：若有活状态行悬挂，先收尾
    if (this._statusActive) this.emit('\n');
    for (const line of text.split('\n')) {
      for (const row of wrapLine(line, this.cols)) {
        this.emit(row + '\n');
      }
    }
    this._setStatusActive(false);
  }
}
