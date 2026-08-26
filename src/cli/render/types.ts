/**
 * 渲染模式共享类型 —— 让备用屏/主屏两个模块可以独立设计、独立解决问题。
 * 公共接口 + 输入驱动（driver）把「模式特有行为」与「通用行编辑器」解耦。
 */

/** 两个渲染模式（AltScreenState / MainScreenState）共有的方法（input-buffer 用输入子集，renderer 用输出子集）。 */
export interface ScreenStateLike {
  cols: number;
  emit(raw: string): void;
  contentLines(chars: string[]): number;
  cursorPos(chars: string[], cursor: number): { line: number; col: number };
  foldInput(chars: string[], startCol?: number): string;
  printPrompt(): void;
  rewriteInput(folded: string, newRows: number, line: number, col: number): void;
  submitInput(rawText: string): void;
  beginStatus(content: string, leadingNewline: boolean): void;
  overwriteStatus(content: string): void;
  endStatus(finalContent: string): void;
  writeLines(text: string): void;
  displayTools(lines: string[]): void;
}

/** 输入驱动：把模式特有行为（滚动键、追加 echo、退出清理）注入通用行编辑器。 */
export interface InputDriver {
  /** 滚动键等消费 chunk（备用屏自实现 scrollback）；返回 true 表示 chunk 已被消费。 */
  consumeChunk?(chunk: string): boolean;
  /** 追加 echo（打字/粘贴在末尾追加时）。 */
  append(chars: string[], oldCursor: number): void;
  /** 退出前的模式特有清理（备用屏恢复主屏等）。 */
  cleanup?(): void;
}
