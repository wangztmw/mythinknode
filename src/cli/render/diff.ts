/**
 * Diff — 逐 cell 比较新旧网格，产出每行连续变化段（patch）。
 */
import type { Cell, CellGrid } from './cell-grid.js';

export interface Patch {
  row: number;
  col: number;
  cells: Cell[];
}

export function diff(prev: CellGrid, next: CellGrid): Patch[] {
  const patches: Patch[] = [];
  for (let r = 0; r < next.rows; r++) {
    let c = 0;
    while (c < next.cols) {
      const a = prev.get(r, c), b = next.get(r, c);
      if (a.ch === b.ch && a.style === b.style && a.color === b.color) { c++; continue; }
      const start = c;
      const cells: Cell[] = [];
      while (c < next.cols) {
        const pa = prev.get(r, c), pb = next.get(r, c);
        if (pa.ch === pb.ch && pa.style === pb.style && pa.color === pb.color) break;
        cells.push({ ...pb });
        c++;
      }
      patches.push({ row: r, col: start, cells });
    }
  }
  return patches;
}
