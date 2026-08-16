/**
 * ScreenBuffer — 完整屏幕模型（方向 B）。
 *
 * 持有 scrollback（输出历史）+ 活状态行 + 输入块，compose 出整屏 CellGrid，
 * flush 时 diff 只写变化 cell（光标定位重绘 = 备用屏语义，不靠终端原生滚动）。
 *
 * 关键：每次变更都 _render() 重 compose 进 viewport；flush() 才 diff + emit。
 * 纯逻辑，零 I/O（out 回调注入）。
 */
import { CellGrid, writeAnsiText } from './cell-grid.js';
import { diff } from './diff.js';
import { patchesToANSI } from './emitter.js';
import { wrapLine } from './term-wrap.js';

export class ScreenBuffer {
  readonly rows: number;
  readonly cols: number;
  private scrollback: string[] = [];   // 输出历史（每项 = 一个已折行可视行）
  private scrollOffset = 0;            // 0 = 底部；N = 回滚 N 行
  private status: string | null = null;// 活状态行内容（ANSI），null = 无
  private prompt = '';                 // 输入提示符（ANSI）
  private inputText = '';              // 已折行输入内容（可含 \n）
  private inputActive = false;         // 输入块是否显示
  private cursor = { line: 0, col: 0 };// 输入光标（相对输入块，line 0 = prompt 行）
  private cursorScreen = { row: 0, col: 0 };  // 光标在整屏的坐标（compose 时算）
  private out: (s: string) => void;
  private viewport: CellGrid;          // 当前帧
  private prevViewport: CellGrid;      // 上一帧（已 flush）

  constructor(rows: number, cols: number, out: (s: string) => void = (s) => process.stdout.write(s)) {
    this.rows = rows;
    this.cols = cols;
    this.viewport = new CellGrid(rows, cols);
    this.prevViewport = new CellGrid(rows, cols);
    this.out = out;
  }

  // ---- 输出（scrollback）----

  /** 追加输出：按 cols 折行进 scrollback。回滚状态下同步偏移，保持视口钉在原内容。 */
  writeOutput(text: string): void {
    let added = 0;
    for (const line of text.split('\n')) {
      for (const row of wrapLine(line, this.cols)) { this.scrollback.push(row); added++; }
    }
    if (this.scrollOffset > 0) {
      // 回滚中：新输出把「底部」往下推，偏移同步增加，视口不跳
      const maxOffset = Math.max(0, this.scrollback.length - this.rows);
      this.scrollOffset = Math.min(maxOffset, this.scrollOffset + added);
    }
    this._render();
  }

  /** 回滚：n>0 向上，n<0 向下。 */
  scrollBy(n: number): void {
    const maxOffset = Math.max(0, this.scrollback.length - this.rows);
    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + n));
    this._render();
  }

  /** 是否停在底部（新输出会跟随滚动）。 */
  get atBottom(): boolean { return this.scrollOffset === 0; }

  // ---- 状态行 ----

  get hasStatus(): boolean { return this.status != null; }

  /** 设置活状态行内容（覆盖）。 */
  setStatus(content: string): void { this.status = content; this._render(); }

  /** 提交状态行为永久输出行；finalContent 覆盖最终内容（thinking_end 用）。 */
  commitStatus(finalContent?: string): void {
    if (this.status == null && finalContent == null) return;
    this.scrollback.push(finalContent ?? this.status!);
    this.status = null;
    this._render();
  }

  /** 丢弃活状态行（tool_display 首行替换状态行用）。 */
  discardStatus(): void { if (this.status != null) { this.status = null; this._render(); } }

  // ---- 输入块 ----

  setPrompt(p: string): void { this.prompt = p; this._render(); }

  /** 设置输入内容（已折行）+ 光标（相对输入块）+ 是否显示。 */
  setInput(text: string, cursor: { line: number; col: number }): void {
    this.inputText = text;
    this.cursor = cursor;
    this.inputActive = true;
    this._render();
  }

  /** 隐藏输入块（提交后）。 */
  clearInput(): void { this.inputText = ''; this.inputActive = false; this._render(); }

  // ---- compose + flush ----

  private inputRows(): number {
    if (!this.inputActive) return 0;
    return Math.max(1, this.inputText.split('\n').length);
  }

  /** 把输出 + 状态 + 输入 compose 成整屏网格（自实现 scrollback，顶部对齐）。 */
  private compose(): CellGrid {
    const grid = new CellGrid(this.rows, this.cols);

    // 1. 输入块：贴底，最多占满全屏（超长输入只显示含光标的底部窗口）
    if (this.inputActive) {
      const lines = this.inputText.split('\n');
      const inRows = Math.max(1, lines.length);
      const visible = Math.min(inRows, this.rows);
      const startLine = inRows - visible;      // 显示最后 visible 行（光标通常在末尾）
      const base = this.rows - visible;
      for (let k = 0; k < visible; k++) {
        const srcLine = startLine + k;
        const text = srcLine === 0 ? this.prompt + (lines[srcLine] ?? '') : (lines[srcLine] ?? '');
        writeAnsiText(grid, base + k, 0, text);
      }
      this.cursorScreen = { row: base + (this.cursor.line - startLine), col: this.cursor.col };
    }

    // 2. 输出 + 状态行：占据输入块以上的 [0, rows - visibleIn) 行，顶部对齐
    const contentEnd = this.rows - (this.inputActive ? Math.min(this.inputRows(), this.rows) : 0);
    if (contentEnd > 0) {
      const content = this.hasStatus ? [...this.scrollback, this.status!] : this.scrollback;
      const visible = Math.min(contentEnd, content.length);
      const start = Math.max(0, content.length - visible - this.scrollOffset);
      for (let r = 0; r < visible; r++) {
        const src = start + r;
        if (src >= 0 && src < content.length) writeAnsiText(grid, r, 0, content[src]);
      }
    }

    return grid;
  }

  private _render(): void { this.viewport = this.compose(); }

  /** diff 当前帧 vs 上一帧，emit 变化（含光标定位），更新上一帧。 */
  flush(): void {
    const patches = diff(this.prevViewport, this.viewport);
    let out = patchesToANSI(patches);
    if (this.inputActive) {
      out += `\x1b[${this.cursorScreen.row + 1};${this.cursorScreen.col + 1}H`;
    }
    if (out.length > 0) this.out(out);
    this.prevViewport = this.viewport.clone();
  }

  /** 调试/测试：返回 viewport 每行的显示内容（去样式、去尾部空格）。 */
  snapshot(): string[] {
    const rows: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      let s = '';
      for (let c = 0; c < this.cols; c++) {
        const cell = this.viewport.get(r, c);
        if (cell.ch !== '') s += cell.ch;
      }
      rows.push(s.trimEnd());
    }
    return rows;
  }
}
