/**
 * ScreenState（混合模式）— 主屏 primary buffer + cell-diff 活区 + 原生 scrollback。
 *
 * 借鉴 Claude Code 的混合模型：跑在主屏（不发 \x1b[?1049h），所以终端原生滚动条 +
 * 原生 scrollback 天然存在。高频活区（状态行 + 输入块）走 cell-diff 不发 \n，
 * 低频定稿输出走 \n 进原生 scrollback —— 把崩溃的放大器（\n 原生滚动）压到最低频路径。
 *
 * 与备用屏（screen-state.ts）的区别：不持全历史、不自实现 scrollback（滚动交给终端滚动条），
 * 内容只保留「可见窗」；溢出时原生 \n 滚掉头 + 从模型里 trim 掉，不再寻址。
 *
 * 核心 flush 机制：内容顶部对齐、活区底部锚定，溢出掉头 == 原生滚动掉头。
 * 溢出时「全屏 \n 滚动 + 同步 prevViewport（scroll）+ 残余 diff 只写新底行/活区增量」。
 * 活区永远在底部，全屏滚动不会把它滚出 scrollback，滚上去后由 diff 重写到正确位置——
 * 所以无需 DECSTBM，天然覆盖提交/状态出现/输入增长/输入提交四类过渡。
 * 所有 \n 先于任何 patchesToANSI 的绝对 \x1b[r;cH 发出，光标最后复位，避免光标打架。
 */
import { CellGrid, writeAnsiText } from './cell-grid.js';
import { diff } from './diff.js';
import { patchesToANSI } from './emitter.js';
import { wrapLine, displayWidth } from './term-wrap.js';
import { contentLines as geomContentLines, cursorPos as geomCursorPos, foldInput as geomFoldInput } from '../input/input-geometry.js';
import type { InputDriver } from './types.js';

export class HybridScreenState {
  private prompt: string;
  private promptWidth: number;
  private _rows: number;
  private _cols: number;

  private content: string[] = [];         // 可见的已提交输出（已折行，每行 ≤ cols），有界滑动窗口
  private status: string | null = null;   // 活状态行（ANSI），null = 无
  private inputText = '';                 // 已折行输入内容（可含 \n，仅用于显示）
  private inputActive = false;
  private cursor = { line: 0, col: 0 };   // 输入光标（相对输入块）
  private cursorScreen = { row: 0, col: 0 };
  private endRow = 0;                     // 输入非活跃时光标目标
  private endCol = 0;
  private prevCursorTarget = { row: -1, col: -1 };
  private viewport: CellGrid;             // 当前帧
  private prevViewport: CellGrid;         // 上次已 emit 帧（物理屏）

  constructor(prompt: string, opts?: { rows?: number; cols?: number }) {
    this.prompt = prompt;
    this.promptWidth = displayWidth(prompt);
    this._rows = opts?.rows ?? process.stdout.rows ?? 24;
    this._cols = opts?.cols ?? process.stdout.columns ?? 80;
    this.viewport = new CellGrid(this._rows, this._cols);
    this.prevViewport = new CellGrid(this._rows, this._cols);
  }

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }

  // ---- 唯一 stdout 写咽喉 ----

  emit(raw: string): void { process.stdout.write(raw); }

  // ---- 几何（委托 input-geometry，逐字节等价）----

  contentLines(chars: string[]): number { return geomContentLines(chars, this._cols, this.promptWidth); }
  cursorPos(chars: string[], cursor: number): { line: number; col: number } { return geomCursorPos(chars, cursor, this._cols, this.promptWidth); }
  foldInput(chars: string[], startCol: number = this.promptWidth): string { return geomFoldInput(chars, this._cols, startCol); }

  // ---- 内部：布局 ----

  private _inputRows(): number {
    if (!this.inputActive) return 0;
    return Math.min(this._rows, Math.max(1, this.inputText.split('\n').length));
  }

  private _liveRows(): number {
    return (this.status != null ? 1 : 0) + this._inputRows();
  }

  private _contentCap(): number {
    return Math.max(0, this._rows - this._liveRows());
  }

  /** 追加一个原始行（折行进 content）。 */
  private _pushLine(line: string): void {
    for (const row of wrapLine(line, this._cols)) this.content.push(row);
  }

  /** 提交活状态行为永久输出行；finalContent 覆盖最终内容（thinking_end 用）。 */
  private _commitStatus(finalContent?: string): void {
    if (this.status == null && finalContent == null) return;
    this._pushLine(finalContent ?? this.status!);
    this.status = null;
  }

  /** 移除 content 末尾空行（回车提交时加的换行空行，第一个 thinking 填掉）。 */
  private _discardTrailingBlank(): void {
    if (this.content.length > 0 && this.content[this.content.length - 1] === '') {
      this.content.pop();
    }
  }

  /** 内容顶部对齐 + 活区（status + input）底部锚定，compose 出整屏网格。 */
  private _compose(): CellGrid {
    const grid = new CellGrid(this._rows, this._cols);
    const inputRows = this._inputRows();
    const contentCap = this._contentCap();

    // 1. 内容顶部对齐
    const visible = Math.min(this.content.length, contentCap);
    for (let r = 0; r < visible; r++) {
      writeAnsiText(grid, r, 0, this.content[r]);
    }

    // 2. 状态行：紧贴输入块上方（无输入时即 content 区之下）
    if (this.status != null) {
      writeAnsiText(grid, contentCap, 0, this.status);
    }

    // 3. 输入块底部锚定，超长输入只显示含光标的底部窗口
    if (this.inputActive) {
      const lines = this.inputText.split('\n');
      const inRows = Math.max(1, lines.length);
      const startLine = inRows - inputRows;
      const inputTop = this._rows - inputRows;
      for (let k = 0; k < inputRows; k++) {
        const srcLine = startLine + k;
        const text = srcLine === 0 ? this.prompt + (lines[srcLine] ?? '') : (lines[srcLine] ?? '');
        writeAnsiText(grid, inputTop + k, 0, text);
      }
      this.cursorScreen = { row: inputTop + (this.cursor.line - startLine), col: this.cursor.col };
    }

    // 4. 输入非活跃时光标目标：status 末尾 / 最后内容行末尾 / 0,0
    if (!this.inputActive) {
      if (this.status != null) {
        this.endRow = contentCap;
        this.endCol = displayWidth(this.status);
      } else if (this.content.length > 0) {
        this.endRow = Math.min(this.content.length, contentCap) - 1;
        this.endCol = displayWidth(this.content[this.endRow]);
      } else {
        this.endRow = 0;
        this.endCol = 0;
      }
    }

    return grid;
  }

  /** 原生全屏滚动上移 k 行：光标落底行，\n 触发滚动，滚掉的行走 scrollback。 */
  private _emitScroll(k: number): void {
    this.emit(`\x1b[${this._rows};1H` + '\n'.repeat(k));
  }

  /** 所有变更走单一 flush：溢出 → 原生滚 + trim；其余 diff 只写变化。 */
  private _flush(): void {
    const contentCap = this._contentCap();
    const overflow = Math.max(0, this.content.length - contentCap);

    if (overflow > 0) {
      this.content.splice(0, overflow);
      this._emitScroll(overflow);
      this.prevViewport.scroll(overflow);
    }

    this.viewport = this._compose();
    const patches = diff(this.prevViewport, this.viewport);
    let out = patchesToANSI(patches);

    const target = this.inputActive ? this.cursorScreen : { row: this.endRow, col: this.endCol };
    const targetChanged = target.row !== this.prevCursorTarget.row || target.col !== this.prevCursorTarget.col;
    if (patches.length > 0 || targetChanged) {
      out += `\x1b[${target.row + 1};${target.col + 1}H`;
      this.prevCursorTarget = target;
    }
    if (out.length > 0) this.emit(out);

    this.prevViewport = this.viewport.clone();
  }

  // ---- 输入块原语 ----

  printPrompt(): void {
    if (this.status != null) this._commitStatus();  // 悬空状态行先收尾
    this.inputText = '';
    this.cursor = { line: 0, col: this.promptWidth };
    this.inputActive = true;
    this._flush();
  }

  rewriteInput(folded: string, _newRows: number, line: number, col: number): void {
    this.inputText = folded;
    this.cursor = { line, col };
    this._flush();
  }

  submitInput(rawText: string): void {
    if (!this.inputActive) return;
    const lines = rawText.split('\n');
    for (let k = 0; k < lines.length; k++) {
      this._pushLine(k === 0 ? this.prompt + lines[k] : lines[k]);
    }
    this._pushLine('');  // 回车换行
    this.inputText = '';
    this.inputActive = false;
    this._flush();
  }

  // ---- 输出原语 ----

  beginStatus(content: string, leadingNewline: boolean): void {
    if (this.status != null) this._commitStatus();  // 防御：不应发生
    if (leadingNewline) {
      this._pushLine('');                           // 连续 thinking 之间空行分隔
    } else {
      this._discardTrailingBlank();                 // 第一个 thinking 填进回车空行
    }
    this.status = content;
    this._flush();
  }

  overwriteStatus(content: string): void {
    this.status = content;
    this._flush();
  }

  endStatus(finalContent: string): void {
    this._commitStatus(finalContent);
    this._flush();
  }

  writeLines(text: string): void {
    if (this.status != null) this._commitStatus();  // 悬空状态行先收尾
    for (const line of text.split('\n')) this._pushLine(line);
    this._flush();
  }

  displayTools(lines: string[]): void {
    this.status = null;                             // 首行替换状态行
    for (const line of lines) this._pushLine(line);
    this._flush();
  }

  // ---- 终端尺寸变化 ----

  /** 尺寸变化：更新网格、清 prevViewport 强制全量重绘可见窗（不 \x1b[2J，主屏 scrollback 不能清）。 */
  onResize(): void {
    const rows = process.stdout.rows ?? this._rows;
    const cols = process.stdout.columns ?? this._cols;
    if (rows === this._rows && cols === this._cols) return;
    this._rows = rows;
    this._cols = cols;
    this.prevViewport = new CellGrid(rows, cols);
    this._flush();
  }

  // ---- 调试/测试 ----

  snapshot(): string[] {
    const rows: string[] = [];
    for (let r = 0; r < this._rows; r++) {
      let s = '';
      for (let c = 0; c < this._cols; c++) {
        const cell = this.viewport.get(r, c);
        if (cell.ch !== '') s += cell.ch;
      }
      rows.push(s.trimEnd());
    }
    return rows;
  }
}

/** 混合模式输入驱动：无滚动键（终端原生滚动条处理滚动），append 走 cell-diff。 */
export function createHybridDriver(ss: HybridScreenState): InputDriver {
  return {
    append(chars: string[], _oldCursor: number): void {
      const { line, col } = ss.cursorPos(chars, chars.length);
      ss.rewriteInput(ss.foldInput(chars), ss.contentLines(chars), line, col);
    },
  };
}
