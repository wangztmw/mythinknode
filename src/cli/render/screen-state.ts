/**
 * ScreenState — 单一屏幕模型（主屏 + 原生滚动 + 低写频输入）。
 *
 * 主屏语义：输出用原生 \n（滚动条可见可拖、内容滚进终端 scrollback），
 * 输入块用 O(1) 追加 echo（打字只写新字符），状态行用心跳前缀 diff ——
 * 避免高频 \x1b[J 全量重绘（nano 崩溃源），也不软折行（软折行超长触发缺字 bug）。
 *
 * 不变量：
 *   I2 活状态行不悬挂 —— 写多行输出 / prompt 前先 \n 收尾。
 *   I3 单写路径 —— 所有 stdout 写经 emit()。
 */
import { displayWidth, wrapLine } from './term-wrap.js';
import { contentLines as geomContentLines, cursorPos as geomCursorPos, foldInput as geomFoldInput } from '../input/input-geometry.js';

const THROTTLE_TICK_MS = 16;   // 对齐终端 ~60fps 帧
const THROTTLE_LINES_PER_TICK = 10;  // 每帧最多写这么多行，摊开滚动爆发
const INPUT_RESERVE_ROWS = 6;  // 底部固定给输入块的行数（DECSTBM 预留区，折行不触发原生滚动）

export class ScreenState {
  private prompt: string;
  private promptWidth: number;
  private _inputRows = 0;
  private _statusActive = false;
  private _statusLine = '';  // 当前状态行内容，供下次 overwriteStatus 做前缀 diff
  // 节流：大量 \n 一次性写入会触发 Terminal 原生滚动爆发（nano 崩溃源），摊到多帧
  private _pendingLines: string[] = [];
  private _pendingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(prompt: string, _opts?: { rows?: number; cols?: number }) {
    this.prompt = prompt;
    this.promptWidth = displayWidth(prompt);
  }

  get cols(): number { return process.stdout.columns || 80; }

  // ---- 几何（委托 input-geometry） ----

  contentLines(chars: string[]): number { return geomContentLines(chars, this.cols, this.promptWidth); }
  cursorPos(chars: string[], cursor: number): { line: number; col: number } { return geomCursorPos(chars, cursor, this.cols, this.promptWidth); }
  foldInput(chars: string[], startCol: number = this.promptWidth): string { return geomFoldInput(chars, this.cols, startCol); }

  // ---- 唯一 stdout 写咽喉（I3） ----

  emit(raw: string): void { process.stdout.write(raw); }

  // ---- 滚动爆发节流（输出 + 长输入折行共用） ----

  /** 把多行输出入队，摊到每 tick 写 N 行。 */
  private _throttledWrite(lines: string[]): void {
    this._pendingLines.push(...lines);
    if (!this._pendingTimer) this._pendingTimer = setInterval(() => this._flushPending(), THROTTLE_TICK_MS);
  }

  private _flushPending(): void {
    if (this._pendingLines.length === 0) { this._stopPending(); return; }
    this.emit(this._pendingLines.splice(0, THROTTLE_LINES_PER_TICK).join('\n') + '\n');
    if (this._pendingLines.length === 0) this._stopPending();
  }

  private _stopPending(): void {
    if (this._pendingTimer) { clearInterval(this._pendingTimer); this._pendingTimer = null; }
  }

  /** 直写（状态行/输入）前 flush 节流缓冲，保证顺序。 */
  private _flushPendingSync(): void {
    this._stopPending();
    if (this._pendingLines.length > 0) {
      this.emit(this._pendingLines.join('\n') + '\n');
      this._pendingLines = [];
    }
  }

  // ---- 输入块原语 ----

  printPrompt(): void {
    this._flushPendingSync();  // 先把节流的输出写完，prompt 才接得上
    // I2：若有活状态行悬挂，先收尾
    if (this._statusActive) this.emit('\n');
    // 预留输入区（DECSTBM）：输出在 [1, rows-reserve] 滚动（保留滚动条），
    // 输入块固定在 [rows-reserve+1, rows]，折行不触发原生滚动（nano 崩溃源）
    const rows = process.stdout.rows || 24;
    const reserve = Math.min(INPUT_RESERVE_ROWS, Math.max(1, rows - 1));
    this.emit(`\x1b[1;${rows - reserve}r`);
    this.emit(`\x1b[${rows - reserve + 1};1H`);
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

  /** O(1) 追加 echo（光标在末尾时打字）：只写新 chunk，不触发 \x1b[J、不软折行。
   *  长粘贴会折成多行 → 大量 \n 滚动爆发，走节流。 */
  appendInput(foldedChunk: string, newRows: number): void {
    const lines = foldedChunk.split('\n');
    if (lines.length > 8) {
      // 折成很多行（长粘贴）：节流，摊开滚动爆发
      this._throttledWrite(lines);
    } else {
      this.emit(foldedChunk);
    }
    this._inputRows = newRows;
  }

  /** 提交：重置滚动区为全屏，写 \n 收尾输入块（原生屏语义：输入行留在 scrollback 历史里）。 */
  submitInput(_rawText: string): void {
    this._flushPendingSync();
    this.emit('\x1b[r');  // 重置 DECSTBM 滚动区为全屏
    this.emit('\n');
    this._inputRows = 0;
    this._setStatusActive(false);
  }

  // ---- 输出原语（原生 \n） ----

  /** 写一条新状态行（thinking_start）。leadingNewline 时先垫一空行。 */
  beginStatus(content: string, leadingNewline: boolean): void {
    this._flushPendingSync();  // 状态行要接在上一段输出之后
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

  /** 写多行输出：逐行硬折行（无超长行，避免软折行缺字），节流摊开滚动爆发。 */
  writeLines(text: string): void {
    if (this._statusActive) this.emit('\n');  // I2：收尾活状态行（正常流程 endStatus 已收尾，这里是防御）
    const rows: string[] = [];
    for (const line of text.split('\n')) {
      for (const row of wrapLine(line, this.cols)) rows.push(row);
    }
    this._throttledWrite(rows);
    this._setStatusActive(false);
  }

  /** 工具展示：首行 \r 覆盖 tick 的状态行（"● Bash (0.0s)"），其余行正常换行。节流。 */
  displayTools(lines: string[]): void {
    const rows = lines.map((line, i) => `${i === 0 ? '\r' : ''}${line}\x1b[K`);
    this._throttledWrite(rows);
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
