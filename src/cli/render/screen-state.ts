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
  markStatus(active: boolean): void { this._statusActive = active; }

  // ---- 输入块原语 ----

  printPrompt(): void {
    // I2：若有活状态行悬挂，先收尾，避免 prompt 粘到 thinking 行
    if (this._statusActive) this.emit('\n');
    this.emit(this.prompt);
    this._inputRows = 1;
    this._statusActive = false;
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
    this._statusActive = false;
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
    this._statusActive = false;
  }

  // ---- 输出原语 ----

  /** 覆写活状态行（\r 回行首 + 内容 + \x1b[K 清到行尾，无 \n） */
  overwriteStatus(content: string): void {
    this.emit(`\r${content}\x1b[K`);
    this._statusActive = true;
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
    this._statusActive = false;
  }
}
