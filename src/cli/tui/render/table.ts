/**
 * 表格列宽分配（纯函数）。
 *
 * 目标：按内容自然宽度**比例分配**可用宽度，而不是把所有列压成等宽；
 * 每列至少 minWidth，总宽不超过可用宽度。
 */
export function computeColumnWidths(
  natural: number[],
  available: number,
  minWidth = 4,
): number[] {
  if (natural.length === 0) return [];

  const clampedNatural = natural.map(w => Math.max(minWidth, w));
  const totalNatural = clampedNatural.reduce((a, b) => a + b, 0);
  const budget = Math.max(clampedNatural.length * minWidth, available);

  const widths = clampedNatural.map(w =>
    Math.max(minWidth, Math.round((w / totalNatural) * budget)),
  );

  // 收缩到可用宽度
  let sum = widths.reduce((a, b) => a + b, 0);
  while (sum > available) {
    let widest = 0;
    for (let i = 1; i < widths.length; i++) {
      if (widths[i] > widths[widest]) widest = i;
    }
    if (widths[widest] <= minWidth) break;
    widths[widest]--;
    sum--;
  }

  // 把剩余宽度优先还给仍被压缩的列
  let leftover = available - sum;
  while (leftover > 0) {
    const index = widths.findIndex((w, i) => w < clampedNatural[i]);
    if (index === -1) break;
    widths[index]++;
    leftover--;
  }

  return widths;
}
