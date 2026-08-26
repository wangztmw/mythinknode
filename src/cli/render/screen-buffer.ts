/**
 * ScreenBuffer — 完整屏幕模型（方向 B）。
 *
 * 持有 scrollback（输出历史，存「原始逻辑行」）+ 折行缓存 + 活状态行 + 输入块，
 * compose 出整屏 CellGrid，flush 时 diff 只写变化 cell（光标定位重绘 = 备用屏语义）。
 *
 * 关键：scrollback 存原始行（未折行），折行结果缓存进 wrappedLines，resize 时重建缓存——
 * 这样终端尺寸变化后旧内容按新宽度重新折行，不再被截断/错位。
 * 自实现 scrollback：scrollOffset 追踪回滚行数，回滚态在输入块上方画一行指示。
 * 纯逻辑，零 I/O（out 回调注入）。
 */
import { CellGrid, writeAnsiText } from './cell-grid.js';
import { diff } from './diff.js';
import { patchesToANSI } from './emitter.js';
import { wrapLine, displayWidth } from './term-wrap.js';

export class ScreenBuffer {
  rows: number;
  cols: number;
  private rawLines: string[] = [];      // 输出历史（每项 = 一个原始逻辑行，含 ANSI、未折行）
  private wrappedLines: string[] = [];  // 折行缓存（每项 ≤ cols；resize 时重建）
  private scrollOffset = 0;             // 0 = 底部；N = 回滚 N 行
  private status: string | null = null; // 活状态行内容（ANSI），null = 无
  private prompt = '';                  // 输入提示符（ANSI）
  private inputText = '';               // 已折行输入内容（可含 \n，仅用于显示）
  private inputActive = false;          // 输入块是否显示
  private cursor = { line: 0, col: 0 }; // 输入光标（相对输入块，line 0 = prompt 行）
  private cursorScreen = { row: 0, col: 0 };  // 光标在整屏的坐标（compose 时算）
  private endRow = 0;                          // 内容结束的下一行（输入块非活跃时，光标停在此）
  private endCol = 0;                          // 输入块非活跃时光标的列（0=行首，否则落在末尾文字的后面）
  private prevCursorTarget = { row: -1, col: -1 };  // 上次 flush 输出的光标目标（-1 未定位）
  private out: (s: string) => void;
  private viewport: CellGrid;           // 当前帧
  private prevViewport: CellGrid;       // 上一帧（已 flush）

  constructor(rows: number, cols: number, out: (s: string) => void = (s) => process.stdout.write(s)) {
    this.rows = rows;
    this.cols = cols;
    this.viewport = new CellGrid(rows, cols);
    this.prevViewport = new CellGrid(rows, cols);
    this.out = out;
  }

  // ---- 输出（scrollback）----

  /** 追加一个原始逻辑行（进 rawLines，同时折行进 wrappedLines 缓存）。 */
  private _pushRawLine(line: string): void {
    this.rawLines.push(line);
    for (const row of wrapLine(line, this.cols)) this.wrappedLines.push(row);
  }

  /** 追加输出：按 \n 拆成原始行进 scrollback。回滚状态下同步偏移，保持视口钉在原内容。 */
  writeOutput(text: string): void {
    const before = this.wrappedLines.length;
    for (const line of text.split('\n')) this._pushRawLine(line);
    const added = this.wrappedLines.length - before;
    if (this.scrollOffset > 0) {
      // 回滚中：新输出把「底部」往下推，偏移同步增加，视口不跳
      this.scrollOffset = Math.min(this._maxScrollOffset(), this.scrollOffset + added);
    }
    this._render();
  }

  /** 回滚：n>0 向上（看更早），n<0 向下（回更近）。 */
  scrollBy(n: number): void {
    this.scrollOffset = Math.max(0, Math.min(this._maxScrollOffset(), this.scrollOffset + n));
    this._render();
  }

  /** 回到底部（新输出跟随滚动）。 */
  scrollToBottom(): void {
    if (this.scrollOffset !== 0) { this.scrollOffset = 0; this._render(); }
  }

  /** 是否停在底部。 */
  get atBottom(): boolean { return this.scrollOffset === 0; }

  /** 是否回滚中。 */
  get scrolledBack(): boolean { return this.scrollOffset > 0; }

  // ---- 状态行 ----

  get hasStatus(): boolean { return this.status != null; }

  /** 设置活状态行内容（覆盖）。 */
  setStatus(content: string): void { this.status = content; this._render(); }

  /** 提交状态行为永久输出行；finalContent 覆盖最终内容（thinking_end 用）。 */
  commitStatus(finalContent?: string): void {
    if (this.status == null && finalContent == null) return;
    this._pushRawLine(finalContent ?? this.status!);
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

  /** 提交输入块进 scrollback（原生屏语义：按回车后输入行留在历史里），然后隐藏输入块。
   *  rawText = 用户原始输入（未折行、未清洗），存原始行以便 resize 时重新折行。
   *  提交后追加一个空行 —— 模拟「回车换行」：输入锚点在屏幕底部按回车时，
   *  后续内容（thinking/回复）在这空行之上渲染，产生自然滚动的换行效果。 */
  commitInput(rawText: string): void {
    if (!this.inputActive) return;
    const lines = rawText.split('\n');
    for (let k = 0; k < lines.length; k++) {
      this._pushRawLine(k === 0 ? this.prompt + lines[k] : lines[k]);
    }
    this._pushRawLine('');  // 空行：回车换行，后续内容渲染在此之后
    this.inputText = '';
    this.inputActive = false;
    this._render();
  }

  /** 移除 scrollback 末尾的空行（回车提交时加的那个换行空行）。第一个 thinking
   *  直接「填」进这个空行里，而不是另起一行 —— 这样指令和 thinking 之间不留空行，
   *  空行只是回车瞬间的自然换行（随后被 thinking 填满）。 */
  discardTrailingBlank(): void {
    if (this.rawLines.length > 0 && this.rawLines[this.rawLines.length - 1] === '') {
      this.rawLines.pop();
    }
    if (this.wrappedLines.length > 0 && this.wrappedLines[this.wrappedLines.length - 1] === '') {
      this.wrappedLines.pop();
    }
  }

  /** 终端尺寸变化：更新网格尺寸，重建折行缓存（按新 cols 重折），触发全量重绘。 */
  resize(rows: number, cols: number): void {
    if (rows === this.rows && cols === this.cols) return;
    this.rows = rows;
    this.cols = cols;
    this._rebuildWrapped();
    this.scrollOffset = Math.min(this.scrollOffset, this._maxScrollOffset());
    this.prevViewport = new CellGrid(rows, cols);  // 清空 → 下次 flush 全量重绘
    this._render();
  }

  private _rebuildWrapped(): void {
    this.wrappedLines = [];
    for (const line of this.rawLines) {
      for (const row of wrapLine(line, this.cols)) this.wrappedLines.push(row);
    }
  }

  // ---- 布局 + compose + flush ----

  private inputRows(): number {
    if (!this.inputActive) return 0;
    return Math.max(1, this.inputText.split('\n').length);
  }

  /** 最大可回滚行数 = 折行后内容总行数 - 内容区「未滚动」高度（rows - inputVisible）。 */
  private _maxScrollOffset(): number {
    const content = this.wrappedLines.length + (this.hasStatus ? 1 : 0);
    const inputVisible = this.inputActive ? Math.min(this.inputRows(), this.rows) : 0;
    return Math.max(0, content - (this.rows - inputVisible));
  }

  /** 把输出 + 状态 + 输入（+ 回滚指示）compose 成整屏网格。
   *  布局 = chat 流：输入块紧跟内容之后，内容溢出屏幕才贴底（滚动）。 */
  private compose(): CellGrid {
    const grid = new CellGrid(this.rows, this.cols);

    const indicatorRows = (this.inputActive && this.scrollOffset > 0) ? 1 : 0;
    const totalContent = this.wrappedLines.length + (this.hasStatus ? 1 : 0);

    // 输入块可见行数 + 内容区「未滚动」高度（输入块上方的行数）
    const inputVisible = this.inputActive ? Math.min(this.inputRows(), Math.max(0, this.rows - indicatorRows)) : 0;
    const contentBottomWindow = this.rows - inputVisible;

    // 1. 输入块：内容后紧跟，溢出才贴底；超长输入只显示含光标的底部窗口
    let inputTop = this.rows;
    if (this.inputActive) {
      const lines = this.inputText.split('\n');
      const inRows = Math.max(1, lines.length);
      const startLine = inRows - inputVisible;
      inputTop = this.scrollOffset > 0
        ? this.rows - inputVisible                          // 回滚中：贴底
        : Math.min(totalContent, contentBottomWindow);      // 内容后紧跟，溢出才贴底
      for (let k = 0; k < inputVisible; k++) {
        const srcLine = startLine + k;
        const text = srcLine === 0 ? this.prompt + (lines[srcLine] ?? '') : (lines[srcLine] ?? '');
        writeAnsiText(grid, inputTop + k, 0, text);
      }
      this.cursorScreen = { row: inputTop + (this.cursor.line - startLine), col: this.cursor.col };
    }

    // 2. 回滚指示行：输入块上方
    if (indicatorRows) {
      const indRow = inputTop - 1;
      if (indRow >= 0) writeAnsiText(grid, indRow, 0, `↑${this.scrollOffset}行 PgDn回底`);
    }

    // 3. 输出 + 状态行：占据 [0, contentEnd) 行，顶部对齐
    const contentEnd = Math.max(0, inputTop - indicatorRows);
    this.endRow = 0;
    this.endCol = 0;
    if (contentEnd > 0) {
      const visible = Math.min(contentEnd, totalContent);
      const start = Math.max(0, totalContent - contentBottomWindow - this.scrollOffset);
      for (let r = 0; r < visible; r++) {
        const src = start + r;
        const text = src < this.wrappedLines.length ? this.wrappedLines[src] : this.status!;
        writeAnsiText(grid, r, 0, text);
      }
      // 光标始终落在最后一行文字的末尾（跟随文字），无论内容是否占满屏幕。
      if (visible > 0) {
        this.endRow = visible - 1;
        const lastSrc = start + visible - 1;
        const lastText = lastSrc < this.wrappedLines.length ? this.wrappedLines[lastSrc] : this.status!;
        this.endCol = displayWidth(lastText);
      }
    }

    return grid;
  }

  private _render(): void { this.viewport = this.compose(); }

  /** diff 当前帧 vs 上一帧，emit 变化（含光标定位），更新上一帧。 */
  flush(): void {
    const patches = diff(this.prevViewport, this.viewport);
    let out = patchesToANSI(patches);
    // 光标定位：补丁写了字符会移动光标（如状态行秒数变化），必须重新定位到目标；
    // 或目标变化（提交后视觉无 diff 但光标要移到下一行）。
    const rawTarget = this.inputActive
      ? this.cursorScreen
      : { row: this.endRow, col: this.endCol };
    // 光标列钳到 cols-1：pending-wrap（col==cols，输入恰好铺满一行）时列越界，
    // 若发 \x1b[r;cols+1H 会让 Terminal.app 越界换行/滚动 ——「行末疯狂滚动」的根因。
    // 行钳到 [0, rows-1]：长输入折行超过可见窗时，光标在窗口之上（Home/↑）会让
    // cursor.line - startLine < 0 → 负行号越界。
    const target = {
      row: Math.min(Math.max(rawTarget.row, 0), this.rows - 1),
      col: Math.min(rawTarget.col, this.cols - 1),
    };
    const targetChanged = target.row !== this.prevCursorTarget.row || target.col !== this.prevCursorTarget.col;
    if (patches.length > 0 || targetChanged) {
      out += `\x1b[${target.row + 1};${target.col + 1}H`;
      this.prevCursorTarget = target;
    }
    if (out.length > 0) this.out(out);
    this.prevViewport = this.viewport.clone();
  }

  /** 调试/测试：返回 viewport 每行的显示内容（去样式、去尾部空格、去最右滚动条列）。 */
  snapshot(): string[] {
    const rows: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      let s = '';
      for (let c = 0; c < this.cols - 1; c++) {
        const cell = this.viewport.get(r, c);
        if (cell.ch !== '') s += cell.ch;
      }
      rows.push(s.trimEnd());
    }
    return rows;
  }
}
