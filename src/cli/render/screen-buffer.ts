/**
 * ScreenBuffer — 完整屏幕模型（方向 B）。
 * 持有 scrollback（输出历史）+ viewport（可见窗口 CellGrid）+ 滚动偏移，
 * flush 时 diff viewport 只写变化部分。
 *
 * 关键：cursor 定位重绘 = 固定屏幕（备用屏）语义，不与主屏原生滚动混用。
 * 纯逻辑，零 I/O（out 回调注入）。
 */
import { CellGrid, writeAnsiText } from './cell-grid.js';
import { diff } from './diff.js';
import { patchesToANSI } from './emitter.js';
import { wrapLine } from './term-wrap.js';

export class ScreenBuffer {
  readonly rows: number;
  readonly cols: number;
  private scrollback: string[] = [];      // 输出历史（每项 = 一个已折行可视行）
  private viewport: CellGrid;
  private prevViewport: CellGrid;
  private scrollOffset = 0;               // 0 = 底部；N = 回滚 N 行
  private out: (s: string) => void;

  constructor(rows: number, cols: number, out: (s: string) => void = (s) => process.stdout.write(s)) {
    this.rows = rows;
    this.cols = cols;
    this.viewport = new CellGrid(rows, cols);
    this.prevViewport = new CellGrid(rows, cols);
    this.out = out;
  }

  /** 追加输出：按 cols 折行进 scrollback；若在底部则跟随滚动。 */
  writeOutput(text: string): void {
    for (const line of text.split('\n')) {
      for (const row of wrapLine(line, this.cols)) this.scrollback.push(row);
    }
    if (this.scrollOffset === 0) this._renderViewport();
  }

  /** 回滚：n>0 向上，n<0 向下。 */
  scrollBy(n: number): void {
    const maxOffset = Math.max(0, this.scrollback.length - this.rows);
    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + n));
    this._renderViewport();
  }

  /** 是否停在底部（新输出会跟随滚动）。 */
  get atBottom(): boolean { return this.scrollOffset === 0; }

  /** 把可见窗口渲染进 viewport（从 scrollback 取 bottom rows 减 offset）。 */
  private _renderViewport(): void {
    for (let r = 0; r < this.rows; r++) this.viewport.clearRow(r);
    const start = Math.max(0, this.scrollback.length - this.rows - this.scrollOffset);
    for (let r = 0; r < this.rows; r++) {
      const src = start + r;
      if (src >= 0 && src < this.scrollback.length) writeAnsiText(this.viewport, r, 0, this.scrollback[src]);
    }
  }

  /** diff 当前 viewport vs 上一帧，emit 变化，更新上一帧。 */
  flush(): void {
    const patches = diff(this.prevViewport, this.viewport);
    if (patches.length > 0) this.out(patchesToANSI(patches));
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
