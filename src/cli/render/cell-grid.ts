/**
 * CellGrid — 二维屏幕网格（方向 B 的「完整内容模型」）。
 * 每个 cell = { ch, style, color }，列号按「显示列」计（CJK 双宽占 2 格）。
 * style 位掩码：1 = bold；color 为前景色 SGR 码（0=默认, 30-37/90-97）。
 * 纯逻辑，零 I/O；渲染由 diff + sink 负责。
 */
import { charWidth } from './term-wrap.js';

export interface Cell {
  ch: string;      // 字符；双宽字符的后半格为 ''（占位）
  style: number;   // 位掩码：1 = bold
  color: number;   // 前景色 SGR 码（0=默认）
}

export const STYLE_BOLD = 1;

/** 解析 ANSI SGR（bold + 前景色，按序应用），把带样式的文本写入网格。返回下一个列号。
 *  maxCols 限制写入宽度（默认 grid.cols；备用屏最右一列留给滚动条，内容用 cols-1）。 */
export function writeAnsiText(grid: CellGrid, row: number, col: number, text: string, maxCols: number = grid.cols): number {
  let style = 0;
  let color = 0;
  let c = col;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const m = /^\x1b\[([0-9;]*)m/.exec(text.slice(i));
      if (m) {
        for (const code of m[1].split(';')) {
          if (code === '1') style = STYLE_BOLD;
          else if (code === '22' || code === '0') style = 0;
          else if (code === '39') color = 0;
          else if (/^(3[0-7]|9[0-7])$/.test(code)) color = parseInt(code, 10);
        }
        i += m[0].length - 1;
      }
      continue;
    }
    const ch = text[i];
    const w = charWidth(ch);
    if (c + w > maxCols) break;
    grid.set(row, c, ch, style, color);
    if (w === 2) grid.set(row, c + 1, '', style, color);
    c += w;
  }
  return c;
}

export class CellGrid {
  readonly rows: number;
  readonly cols: number;
  private cells: Cell[][];

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.cells = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ ch: ' ', style: 0, color: 0 }))
    );
  }

  get(row: number, col: number): Cell { return this.cells[row][col]; }

  set(row: number, col: number, ch: string, style: number, color: number = 0): void {
    this.cells[row][col] = { ch, style, color };
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
      this.cells[row][c] = { ch, style, color: 0 };
      if (w === 2) this.cells[row][c + 1] = { ch: '', style, color: 0 };
      c += w;
    }
    return c;
  }

  /** 顶部 n 行滚出，下方行上移，底部补空行。 */
  scroll(n: number): void {
    for (let r = 0; r < this.rows - n; r++) this.cells[r] = this.cells[r + n];
    for (let r = this.rows - n; r < this.rows; r++)
      this.cells[r] = Array.from({ length: this.cols }, () => ({ ch: ' ', style: 0, color: 0 }));
  }

  clone(): CellGrid {
    const g = new CellGrid(this.rows, this.cols);
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) g.cells[r][c] = { ...this.cells[r][c] };
    return g;
  }
}
