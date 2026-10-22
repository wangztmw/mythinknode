/**
 * 断点 — 会话 UI 与只读看板使用**两套独立阈值**。
 * 看板阈值保持原有 84 / 72 / 30，不能因会话断点调整而回退。
 */
export type BreakpointName = 'narrow' | 'compact' | 'normal' | 'wide';

export interface Breakpoint {
  name: BreakpointName;
  columns: number;
  rows: number;
  narrow: boolean;
  compact: boolean;
  wide: boolean;
}

export function getBreakpoint(columns: number, rows: number): Breakpoint {
  const name: BreakpointName =
    columns < 50 ? 'narrow'
      : columns < 80 ? 'compact'
        : columns < 120 ? 'normal'
          : 'wide';

  return {
    name,
    columns,
    rows,
    narrow: name === 'narrow',
    compact: name === 'narrow' || name === 'compact',
    wide: name === 'wide',
  };
}

/** 看板专用阈值（保持现有行为） */
export const dashboardBreakpoints = {
  twoColumn: (columns: number): boolean => columns >= 84,
  logo: (columns: number, rows: number): boolean => columns >= 72 && rows >= 30,
};

/** 会话欢迎框 logo 阈值 */
export const welcomeLogo = (columns: number): boolean => columns >= 68;
