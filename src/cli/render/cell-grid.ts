/**
 * CellGrid — 二维屏幕网格（方向 B 的「完整内容模型」）。
 * 每个 cell = { ch, style }，列号按「显示列」计（CJK 双宽占 2 格）。
 * 纯逻辑，零 I/O；渲染由 diff + sink 负责。
 */
import { charWidth } from './term-wrap.js';

export interface Cell {
  ch: string;      // 字符；双宽字符的后半格为 ''（占位）
  style: number;   // 位掩码：1 = bold
}

export const STYLE_BOLD = 1;

export class CellGrid {
  readonly rows: number;
  readonly cols: number;
  private cells: Cell[][];

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.cells = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ ch: ' ', style: 0 }))
    );
  }

  get(row: number, col: number): Cell { return this.cells[row][col]; }

  set(row: number, col: number, ch: string, style: number): void {
    this.cells[row][col] = { ch, style };
  }

  /**
   * 在 (row, col) 写一段文本（不含 \n），按 charWidth 推进列（CJK 占 2 格）。
   * 超出右缘则截断。返回写完后下一个列号。
   */
  write(row: number, col: number, text: string, style: number): number {
    let c = col;
    for (const ch of text) {
      const w = charWidth(ch);
      if (c + w > this.cols) break;
      this.cells[row][c] = { ch, style };
      if (w === 2) this.cells[row][c + 1] = { ch: '', style };
      c += w;
    }
    return c;
  }

  clearRow(row: number): void {
    for (let c = 0; c < this.cols; c++) this.cells[row][c] = { ch: ' ', style: 0 };
  }

  /** 顶部 n 行滚出，下方行上移，底部补空行。 */
  scroll(n: number): void {
    for (let r = 0; r < this.rows - n; r++) this.cells[r] = this.cells[r + n];
    for (let r = this.rows - n; r < this.rows; r++)
      this.cells[r] = Array.from({ length: this.cols }, () => ({ ch: ' ', style: 0 }));
  }

  clone(): CellGrid {
    const g = new CellGrid(this.rows, this.cols);
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) g.cells[r][c] = { ...this.cells[r][c] };
    return g;
  }
}
