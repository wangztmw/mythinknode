/**
 * Emitter — 把 diff 产出的 patches 转成 ANSI 字节串（sink 的核心转换）。
 * 光标定位（1 基）+ 写字符 + 样式（bold）切换。
 */
import type { Patch } from './diff.js';
import { STYLE_BOLD } from './cell-grid.js';

export function patchesToANSI(patches: Patch[]): string {
  let out = '';
  let bold = false;
  let color = 0;
  for (const p of patches) {
    out += `\x1b[${p.row + 1};${p.col + 1}H`;
    for (const cell of p.cells) {
      if (cell.ch === '') continue;  // 双宽后半格跳过
      const wantBold = (cell.style & STYLE_BOLD) !== 0;
      if (wantBold !== bold) {
        out += wantBold ? '\x1b[1m' : '\x1b[22m';
        bold = wantBold;
      }
      if (cell.color !== color) {
        out += cell.color === 0 ? '\x1b[39m' : `\x1b[${cell.color}m`;
        color = cell.color;
      }
      out += cell.ch;
    }
  }
  if (bold) out += '\x1b[22m';
  if (color !== 0) out += '\x1b[39m';
  return out;
}
