/**
 * MainScreenState（主屏版）— 原生滚动 + 低写频输入。
 *
 * 用于 iTerm2 等不触发 nano 崩溃的终端：输出走原生 \n（滚动条可见可拖、内容进 scrollback），
 * 输入块走 O(1) 追加 echo，状态行心跳前缀 diff —— 避免高频 \x1b[J 全量重绘。
 *
 * 共享骨架（promptWidth / emit / 几何委托）由 ScreenStateBase 提供。
 *
 * 不变量：
 *   I2 活状态行不悬挂 —— 写多行输出 / prompt 前先 \n 收尾。
 *   I3 单写路径 —— 所有 stdout 写经 emit()。
 */
import { displayWidth, wrapLine } from './term-wrap.js';
import { ScreenStateBase } from './screen-state-base.js';
import type { InputDriver } from './types.js';

export class MainScreenState extends ScreenStateBase {
  private _inputRows = 0;
  private _statusActive = false;
  private _statusLine = '';  // 当前状态行内容，供下次 overwriteStatus 做前缀 diff

  constructor(prompt: string) {
    super(prompt);
  }

  get cols(): number { return process.stdout.columns || 80; }

  // ---- 输入块原语 ----

  printPrompt(): void {
    // I2：若有活状态行悬挂，先收尾
    if (this._statusActive) this.emit('\n');
    this.emit(this.prompt);
    this._inputRows = 1;
    this._setStatusActive(false);
  }

  /** 重绘输入块（编辑操作：方向键/退格/中间插入）。\x1b[J 只在低频编辑时用。 */
  rewriteInput(folded: string, newRows: number, line: number, col: number): void {
    let out = '';
    if (this._inputRows > 1) out += `\x1b[${this._inputRows - 1}A`;
    out += `\r\x1b[J${this.prompt}${folded}`;
    const upToCursor = newRows - 1 - line;
    if (upToCursor > 0) out += `\x1b[${upToCursor}A`;
    out += '\r';
    if (col > 0) out += `\x1b[${col}C`;
    this._inputRows = newRows;
    this._setStatusActive(false);
    this.emit(out);
  }

  /** O(1) 追加 echo（光标在末尾时打字）：只写新 chunk，不触发 \x1b[J、不软折行。 */
  appendInput(foldedChunk: string, newRows: number): void {
    this.emit(foldedChunk);
    this._inputRows = newRows;
  }

  /** 提交：写 \n 收尾输入块（原生屏语义：输入行留在 scrollback 历史里）。 */
  submitInput(_rawText: string): void {
    this.emit('\n');
    this._inputRows = 0;
    this._setStatusActive(false);
  }

  // ---- 输出原语（原生 \n） ----

  /** 写一条新状态行（thinking_start）。leadingNewline 时先垫一空行。 */
  beginStatus(content: string, leadingNewline: boolean): void {
    this._statusLine = content;
    this._setStatusActive(true);
    this.emit(`${leadingNewline ? '\n' : ''}${content}\x1b[K`);
  }

  /** 覆写活状态行：与上次内容做前缀 diff，只写变化部分（降写频）。 */
  overwriteStatus(content: string): void {
    const prev = this._statusLine;
    this._statusLine = content;
    this._setStatusActive(true);

    if (prev === '') { this.emit(`\r${content}\x1b[K`); return; }

    let p = 0;
    const min = Math.min(prev.length, content.length);
    while (p < min && prev[p] === content[p]) p++;
    const prefix = prev.slice(0, p);

    // diff 点落在粗体段内 → 回退整行写，避免 SGR 错乱
    if (this._endsInBold(prefix)) { this.emit(`\r${content}\x1b[K`); return; }

    if (p === prev.length) { this.emit(content.slice(p)); return; }

    const prefixW = displayWidth(prefix);
    const prevW = displayWidth(prev);
    const newW = displayWidth(content);
    let out = `\r\x1b[${prefixW}C${content.slice(p)}`;
    if (newW < prevW) out += '\x1b[K';
    this.emit(out);
  }

  /** 状态行定稿为永久输出行（thinking_end）。\r 覆盖中间态 + \n 收尾。 */
  endStatus(finalContent: string): void {
    this.emit(`\r${finalContent}\x1b[K\n`);
    this._setStatusActive(false);
    this._statusLine = '';
  }

  /** 写多行输出：先收尾活状态行，再逐行硬折行写（无超长行，避免软折行缺字）。 */
  writeLines(text: string): void {
    if (this._statusActive) this.emit('\n');  // I2
    let out = '';
    for (const line of text.split('\n')) {
      for (const row of wrapLine(line, this.cols)) out += row + '\n';
    }
    this.emit(out);
    this._setStatusActive(false);
  }

  /** 工具展示：首行 \r 覆盖 tick 的状态行（"● Bash (0.0s)"），其余行正常换行。 */
  displayTools(lines: string[]): void {
    let out = '';
    let first = true;
    for (const line of lines) {
      out += `${first ? '\r' : ''}${line}\x1b[K\n`;
      first = false;
    }
    this.emit(out);
    this._setStatusActive(false);
    this._statusLine = '';
  }

  // ---- 内部 ----

  private _setStatusActive(active: boolean): void {
    this._statusActive = active;
    if (!active) this._statusLine = '';
  }

  /** 前缀的粗体是否未闭合（diff 点落在 \x1b[1m… 内） */
  private _endsInBold(prefix: string): boolean {
    let bold = false;
    for (let i = 0; i < prefix.length; i++) {
      if (prefix[i] === '\x1b' && prefix[i + 1] === '[') {
        const m = /^\x1b\[([0-9;]*)m/.exec(prefix.slice(i));
        if (m) {
          const codes = m[1].split(';');
          if (codes.includes('1')) bold = true;
          else if (codes.includes('22') || codes.includes('0')) bold = false;
          i += m[0].length - 1;
        }
      }
    }
    return bold;
  }
}

/** 主屏输入驱动：无滚动键、无备用屏，追加走 O(1) appendInput（只写新字符）。 */
export function createMainDriver(ss: MainScreenState): InputDriver {
  return {
    append(chars: string[], oldCursor: number): void {
      const { col: startCol } = ss.cursorPos(chars, oldCursor);
      const newChars = chars.slice(oldCursor);
      ss.appendInput(ss.foldInput(newChars, startCol), ss.contentLines(chars));
    },
  };
}
