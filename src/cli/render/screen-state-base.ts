/**
 * ScreenStateBase — 主屏/备用屏共享的骨架。
 *
 * 承载两模式相同的 plumbing：
 *   - 提示符宽度 promptWidth（displayWidth 计算）
 *   - 唯一 stdout 写咽喉 emit()（I3 单写路径）
 *   - 几何委托 contentLines/cursorPos/foldInput（委托 input-geometry，逐字节等价）
 *
 * 两个模式各自实现 `get cols()` 与输入/输出原语（printPrompt/beginStatus/…），
 * 共同满足 ScreenStateLike 接口（结构类型）——renderer / input-buffer 只依赖该接口。
 */
import { displayWidth } from './term-wrap.js';
import { contentLines as geomContentLines, cursorPos as geomCursorPos, foldInput as geomFoldInput } from '../input/input-geometry.js';

export abstract class ScreenStateBase {
  protected prompt: string;
  protected promptWidth: number;

  constructor(prompt: string) {
    this.prompt = prompt;
    this.promptWidth = displayWidth(prompt);
  }

  /** 每行可显示列数（备用屏取网格列数，主屏取终端列数）。 */
  abstract get cols(): number;

  /** 唯一 stdout 写咽喉（I3）。 */
  emit(raw: string): void { process.stdout.write(raw); }

  // ---- 几何（委托 input-geometry） ----

  contentLines(chars: string[]): number { return geomContentLines(chars, this.cols, this.promptWidth); }
  cursorPos(chars: string[], cursor: number): { line: number; col: number } { return geomCursorPos(chars, cursor, this.cols, this.promptWidth); }
  foldInput(chars: string[], startCol: number = this.promptWidth): string { return geomFoldInput(chars, this.cols, startCol); }
}
