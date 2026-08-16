/**
 * ScreenState — 单一屏幕模型（方向 B：二维网格渲染）。
 *
 * 内部驱动 ScreenBuffer（完整内容模型：scrollback + 状态行 + 输入块），
 * 每次变更后 flush() 走 cell-diff 只写变化部分 —— 不再有裸 \r / \x1b[J / 高频 \n 滚动。
 *
 * 保留几何委托（input-geometry 的 contentLines/cursorPos/foldInput）与旧调用方
 * （renderer / input-buffer）的 API，只换「输出到终端」这一层。
 *
 * 不变量：
 *   I1 输入块永远贴底（ScreenBuffer.compose 里 bottom-aligned，与输出历史无关）。
 *   I2 活状态行不悬挂 —— 写输出 / prompt 前先 commitStatus 收尾。
 *   I3 单写路径 —— 所有 stdout 写经 emit()（grid flush 的 out 回调 + 终端模式原语共用）。
 */
import { ScreenBuffer } from './screen-buffer.js';
import { displayWidth } from './term-wrap.js';
import { contentLines as geomContentLines, cursorPos as geomCursorPos, foldInput as geomFoldInput } from '../input/input-geometry.js';
import type { InputDriver } from './types.js';

export class ScreenState {
  private prompt: string;
  private promptWidth: number;
  private sb: ScreenBuffer;

  constructor(prompt: string, opts?: { rows?: number; cols?: number }) {
    this.prompt = prompt;
    this.promptWidth = displayWidth(prompt);
    const rows = opts?.rows ?? process.stdout.rows ?? 24;
    const cols = opts?.cols ?? process.stdout.columns ?? 80;
    this.sb = new ScreenBuffer(rows, cols, (s) => this.emit(s));
    this.sb.setPrompt(prompt);
  }

  get cols(): number { return this.sb.cols; }
  get rows(): number { return this.sb.rows; }
  get scrolledBack(): boolean { return this.sb.scrolledBack; }

  // ---- 自实现 scrollback（B6） ----

  /** 回滚 n 行（n>0 向上看更早，n<0 向下）。 */
  scrollBy(n: number): void { this.sb.scrollBy(n); this.sb.flush(); }

  /** 回到底部（新输出跟随滚动）。 */
  scrollToBottom(): void { this.sb.scrollToBottom(); this.sb.flush(); }

  // ---- 几何（委托 input-geometry，逐字节等价） ----

  contentLines(chars: string[]): number { return geomContentLines(chars, this.cols, this.promptWidth); }
  cursorPos(chars: string[], cursor: number): { line: number; col: number } { return geomCursorPos(chars, cursor, this.cols, this.promptWidth); }
  foldInput(chars: string[], startCol: number = this.promptWidth): string { return geomFoldInput(chars, this.cols, startCol); }

  // ---- 唯一 stdout 写咽喉（I3） ----

  emit(raw: string): void { process.stdout.write(raw); }

  // ---- 终端模式原语（不参与 grid，直接写 stdout） ----

  // 备用屏 + 鼠标滚轮上报（SGR 扩展模式）：滚轮驱动自实现 scrollback。
  // 注意：鼠标上报会拦截点击，选中文本需按住 Option 拖选（终端通例）。
  enterAltScreen(): void { this.emit('\x1b[?1049h\x1b[?1000h\x1b[?1006h'); }
  leaveAltScreen(): void { this.emit('\x1b[?1006l\x1b[?1000l\x1b[?1049l'); }

  /** 终端尺寸变化：清屏 + 更新网格 + 全量重绘。 */
  onResize(): void {
    const rows = process.stdout.rows ?? this.rows;
    const cols = process.stdout.columns ?? this.cols;
    if (rows === this.rows && cols === this.cols) return;
    this.emit('\x1b[2J\x1b[H');  // 清物理屏，避免旧尺寸残留
    this.sb.resize(rows, cols);
    this.sb.flush();
  }

  // ---- 输入块原语（写 grid） ----

  printPrompt(): void {
    // I2：若有活状态行悬挂，先收尾
    if (this.sb.hasStatus) this.sb.commitStatus();
    this.sb.setInput('', { line: 0, col: this.promptWidth });
    this.sb.flush();
  }

  /** 重绘输入块（含光标）。grid diff 已只写变化 cell，无需再分 append/redraw 两路。 */
  rewriteInput(folded: string, newRows: number, line: number, col: number): void {
    this.sb.setInput(folded, { line, col });
    this.sb.flush();
  }

  /** 提交：输入行进 scrollback（留在历史里，存原始文本便于 resize 重折行），再隐藏输入块。 */
  submitInput(rawText: string): void {
    this.sb.commitInput(rawText);
    this.sb.flush();
  }

  // ---- 输出原语（写 grid） ----

  /** 写一条新状态行（thinking_start）。leadingNewline 时先垫一空行（后续 thinking 分隔）。 */
  beginStatus(content: string, leadingNewline: boolean): void {
    if (this.sb.hasStatus) this.sb.discardStatus();  // 防御：不应发生
    if (leadingNewline) this.sb.writeOutput('');     // 空行分隔
    this.sb.setStatus(content);
    this.sb.flush();
  }

  /** 覆写活状态行（thinking_tick / 工具心跳）。grid diff 自动只写变化的秒数 cell。 */
  overwriteStatus(content: string): void {
    this.sb.setStatus(content);
    this.sb.flush();
  }

  /** 状态行定稿为永久输出行（thinking_end）。finalContent 覆盖中间态。 */
  endStatus(finalContent: string): void {
    this.sb.commitStatus(finalContent);
    this.sb.flush();
  }

  /** 写多行输出：先收尾活状态行，再追加输出行（每条按 cols 折行）。 */
  writeLines(text: string): void {
    if (this.sb.hasStatus) this.sb.commitStatus();  // I2
    this.sb.writeOutput(text);
    this.sb.flush();
  }

  /** 工具展示：首行替换活状态行（"● Bash (0.0s)" → 工具详情）。 */
  displayTools(lines: string[]): void {
    if (this.sb.hasStatus) this.sb.discardStatus();  // 首行替换状态行
    this.sb.writeOutput(lines.join('\n'));
    this.sb.flush();
  }

  // ---- 调试/测试 ----

  snapshot(): string[] { return this.sb.snapshot(); }
}

/** 备用屏输入驱动：滚动键（PgUp/PgDn/滚轮）+ grid redraw 追加 + 退出恢复主屏。 */
export function createAltDriver(ss: ScreenState): InputDriver {
  return {
    consumeChunk(chunk: string): boolean {
      const page = Math.max(1, ss.rows - 1);
      if (chunk === '\x1b[5~') { ss.scrollBy(page); return true; }   // PgUp 向上
      if (chunk === '\x1b[6~') { ss.scrollBy(-page); return true; }  // PgDn 向下
      // SGR 鼠标滚轮：\x1b[<b;x;yM（b=64 上滚 / 65 下滚）
      const wheel = /^\x1b\[<(\d+);\d+;\d+[Mm]/.exec(chunk);
      if (wheel) {
        const btn = parseInt(wheel[1], 10);
        if (btn === 64) ss.scrollBy(page);    // 滚轮上 → 看更早
        else if (btn === 65) ss.scrollBy(-page);  // 滚轮下 → 看更近
        return true;  // 鼠标事件（含点击）消费，不进输入模型
      }
      if (ss.scrolledBack) ss.scrollToBottom();  // 非滚动输入先回底
      return false;
    },
    append(chars: string[], _oldCursor: number): void {
      // 统一全量重绘：grid diff 只写变化 cell
      const { line, col } = ss.cursorPos(chars, chars.length);
      ss.rewriteInput(ss.foldInput(chars), ss.contentLines(chars), line, col);
    },
    cleanup(): void { ss.leaveAltScreen(); },
  };
}
