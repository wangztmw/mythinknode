/**
 * TUI 主题 — 只用终端 ANSI 命名色，跟随用户深浅色主题。
 * 正文使用终端默认前景色（text: undefined）。
 */
export const colors = {
  brand: 'red',
  accent: 'cyan',
  magenta: 'magenta',
  gray: 'gray',
  text: undefined as string | undefined,
  error: 'red',
  code: 'yellow',
} as const;

export const spacing = {
  inputPaddingX: 1,
  inputNarrowPaddingX: 0,
  sectionGap: 1,
} as const;
