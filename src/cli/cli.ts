/**
 * CLI — 统一 stdout 渲染，readline 仅接收输入。
 *
 * 宽度自适应：
 *   ≥60列 → \r 原地覆写（正常体验）
 *   <60列 → 仅显示首帧+尾帧（防止 \r+ANSI 折行 + 刷屏）
 */
import type { ProgressEvent, MergedTool } from './monitor/progress.js';
import { pollEvents } from './monitor/progress.js';
import { mdToANSI, B, b, C, c } from './render/ansi.js';
import { safeWrite, displayWidth, charWidth } from './render/term-wrap.js';

const THINKING_PHASES = new Set(['analyzing', 'continuing', 'reviewing results', 'summarizing agent results', 'processing']);

// 每次 runSession 的第一个 thinking 不换行（紧接用户输入行），后续 thinking 才换行
let isFirstThinking = true;

// ---- 渲染 ----

/** CJK 双宽感知截断 */
function trunc(s: string, maxCols: number): string {
  if (displayWidth(s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) <= maxCols) return s;
  let visible = 0, cut = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\x1b') { while (i < s.length && s[i] !== 'm') i++; continue; }
    const code = s.codePointAt(i)!;
    visible += (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
               (code >= 0xF900 && code <= 0xFAFF) || (code >= 0x3000 && code <= 0x303F) ||
               (code >= 0xFF01 && code <= 0xFF60) || (code >= 0xAC00 && code <= 0xD7AF) ? 2 : 1;
    if (visible >= maxCols - 1) { cut = i + 1; break; }
  }
  return s.slice(0, cut) + '…';
}

/** 分辨 thinking 阶段和工具执行阶段的标签 */
function phaseLabel(label: string): string {
  return THINKING_PHASES.has(label) ? 'Thinking' : label;
}

/** 清洗粘贴输入里的终端控制序列（ANSI 码 + 回车符），防止污染 LLM 输入 */
function cleanInput(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')   // ANSI CSI 序列（颜色/光标）
    .replace(/\x1b\][^\x07]*\x07/g, '')         // OSC 序列
    .replace(/\x1b[()][A-Z0-9]/g, '')           // 字符集切换
    .replace(/\r/g, '');                        // 回车符（粘贴时终端换行是 \n，\r 是残留）
}

function renderProgress(event: ProgressEvent): void {
  try {
    const cols = process.stdout.columns || 80;
    const wide = cols >= 60;

    switch (event.type) {
      case 'thinking_start': {
        const name = phaseLabel(event.label);
        const pfx = isFirstThinking ? '' : '\n';
        isFirstThinking = false;
        process.stdout.write(`${pfx}  ● ${B}${name}${b} (0.0s) — ${trunc(event.label, cols - 25)}\x1b[K`);
        break;
      }
      case 'thinking_tick': {
        // 窄终端：只显示首帧，抑制中间 tick 防止刷屏
        if (!wide) break;
        const s = (event.elapsedMs / 1000).toFixed(1);
        const name = phaseLabel(event.label);
        const desc = name === 'Thinking' ? ` — ${trunc(event.label, cols - 25)}` : '';
        process.stdout.write(`\r  ● ${B}${name}${b} (${s}s)${desc}\x1b[K`);
        break;
      }
      case 'thinking_end': {
        const raw = event.elapsedMs / 1000;
        const s = raw < 0.1 ? '<0.1' : raw.toFixed(1);
        const hint = event.toolCount > 0 ? ` → ${event.toolCount} tool${event.toolCount > 1 ? 's' : ''}` : '';
        const pfx = wide ? '\r' : '\n';
        process.stdout.write(`${pfx}  ● ${B}Thinking${b} (${s}s) — ${trunc(event.label, cols - 25)}${hint}\x1b[K\n`);
        break;
      }
      case 'thought': {
        const ansi = mdToANSI(event.text.slice(0, 300));
        process.stdout.write(`  ${wide ? ansi : trunc(ansi, cols - 4)}\n`);
        break;
      }
      case 'tool_display':
        renderMergedTools(event.calls, event.elapsedMs);
        break;
      case 'error':
        process.stdout.write(`  ✗ ${event.message}\n`);
        break;
    }
  } catch { /* 渲染不应崩 */ }
}

function renderMergedTools(merged: MergedTool[], elapsedMs?: number): void {
  const cols = process.stdout.columns || 80;
  const wide = cols >= 60;
  const pfx = wide ? '\r' : '\n';
  for (const m of merged) {
    const label = m.count > 1 ? `${m.name} ×${m.count}` : m.name;
    const params = m.inputs.join(', ');
    const info = m.count > 1 ? `(${m.lines} lines total)` : `→ ${m.sample}`;
    const time = elapsedMs != null ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
    const rest = `${time}: ${params}  ${info}`;
    process.stdout.write(`${pfx}  ● ${B}${label}${b}${trunc(rest, cols - 10)}\x1b[K\n`);
  }
}

// ---- REPL ----

export function createCLI() {
  // 自建内容管理：raw mode + 自管 stdin，彻底绕开 readline。
  //
  // 为什么不用 readline：
  //   - terminal: true  → IME 正常，但超长单行 O(n²) 逐字符回显重绘卡死（实测 5 万字卡死）
  //   - terminal: false → 超长行 O(1)，但 canonical mode 破坏 IME composition 状态机 → 中文输入卡死
  //
  // raw mode 本身就能保 IME（豆包输入法实测正常），readline 的逐字符回显才是卡死根源。
  // 自管方案 = raw mode（保 IME）+ 追加式 echo O(1)（不重绘整行）+ 回车提交 + 光标编辑。
  const PROMPT = `${C}${B}mythinknode${b}${c} ${B}>>>${b} `;

  let resolveLine: ((value: string) => void) | null = null;
  // 字符数组（按 code point 分割，正确处理中文双宽 + emoji 代理对）
  let chars: string[] = [];
  // 光标位置（chars 索引，指向两个字符之间）
  let cursor = 0;
  // bracketed paste 状态：粘贴中 = true。粘贴内容里的 \r 是换行，不是回车提交。
  let inPaste = false;
  let closed = false;
  // 屏幕上当前渲染的输入块行数（从 prompt 行算起）。redraw 前用它上移回输入块第一行。
  let renderedLines = 1;

  // 进入 raw mode（保 IME composition 状态机）
  if (typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
  }
  process.stdin.setEncoding('utf8');
  // 启用 bracketed paste：让终端用 \x1b[200~ 和 \x1b[201~ 包裹粘贴内容，
  // 从而可靠区分"粘贴内容里的换行"和"用户按的回车提交"。
  process.stdout.write('\x1b[?2004h');

  /** 光标所在的行和列（考虑 wrap + 显式 \n + 双宽）。
   *  返回 { line, col }：line 从 0 起（第 0 行是 prompt 所在行），col 是该行的显示列。 */
  const cursorPos = () => {
    const cols = process.stdout.columns || 80;
    const promptW = displayWidth(PROMPT);
    let line = 0, col = promptW;
    for (let i = 0; i < cursor; i++) {
      const c = chars[i];
      if (c === '\n') { line++; col = 0; continue; }
      const w = charWidth(c);
      if (col + w > cols) { line++; col = w; }  // 折行到下一行
      else { col += w; }
    }
    return { line, col };
  };

  /** 内容占用的屏幕行数（从 prompt 行算起），用于重绘时上移清除 */
  const contentLines = () => {
    const cols = process.stdout.columns || 80;
    const promptW = displayWidth(PROMPT);
    let lines = 1, col = promptW;
    for (const c of chars) {
      if (c === '\n') { lines++; col = 0; continue; }
      const w = charWidth(c);
      if (col + w > cols) { lines++; col = w; }
      else { col += w; }
    }
    return lines;
  };

  /** 重绘整块（可能多行）：
   *  上移回输入块第一行 → \r 回行首 → \x1b[J 清屏到末尾 → 写 prompt+全部内容 → 光标定位回 cursor 所在行列 */
  const redraw = () => {
    const newLines = contentLines();
    const { line, col } = cursorPos();
    let out = '';
    // 1. 上移回输入块第一行（屏幕光标可能在最后一行，先回到起始行才能完整清屏）
    if (renderedLines > 1) out += `\x1b[${renderedLines - 1}A`;
    // 2. 回行首 + 清屏到末尾 + 重写 prompt + 全部内容
    out += `\r\x1b[J${PROMPT}${chars.join('')}`;
    // 3. 光标定位：从内容末尾（最后一行）上移回 cursor 所在行，\r 回该行首，右移 col 列
    const upToCursor = newLines - 1 - line;
    if (upToCursor > 0) out += `\x1b[${upToCursor}A`;
    out += '\r';
    if (col > 0) out += `\x1b[${col}C`;
    renderedLines = newLines;
    process.stdout.write(out);
  };

  const settle = () => {
    if (!resolveLine) return;
    const text = cleanInput(chars.join('').trim());
    chars = [];
    cursor = 0;
    renderedLines = 1;
    const resolve = resolveLine;
    resolveLine = null;
    resolve(text);
  };

  process.stdin.on('data', (chunk: string) => {
    if (closed) return;
    // Ctrl+C (0x03) 退出
    if (chunk === '\x03') { process.stdout.write('\nBye.\n'); process.exit(0); }
    // bracketed paste 开始标记：进入粘贴模式，后面的 \r 都是内容换行
    if (chunk.includes('\x1b[200~')) {
      inPaste = true;
      // 去掉开始标记，继续处理剩余内容
      chunk = chunk.replace(/\x1b\[200~/g, '');
      if (chunk === '') return;
    }
    // bracketed paste 结束标记：退出粘贴模式
    if (chunk.includes('\x1b[201~')) {
      inPaste = false;
      chunk = chunk.replace(/\x1b\[201~/g, '');
      if (chunk === '') return;
    }
    // Ctrl+D (0x04) 立即提交
    if (chunk === '\x04') { settle(); return; }
    // 回车提交：仅在非粘贴模式下，单独的 \r 或 \n chunk 才是回车
    if (!inPaste && (chunk === '\r' || chunk === '\n')) {
      settle();
      process.stdout.write('\n');
      return;
    }
    // 方向键左/右（转义序列 \x1b[D / \x1b[C）—— 移动光标，重绘
    if (chunk === '\x1b[D') {
      if (cursor > 0) { cursor--; redraw(); }
      return;
    }
    if (chunk === '\x1b[C') {
      if (cursor < chars.length) { cursor++; redraw(); }
      return;
    }
    // Home / End（可选，完善光标编辑）
    if (chunk === '\x1b[H' || chunk === '\x1b[1~') { cursor = 0; redraw(); return; }
    if (chunk === '\x1b[F' || chunk === '\x1b[4~') { cursor = chars.length; redraw(); return; }
    // 退格（Backspace 0x7f 或 0x08）：删除光标前一个字符，双宽感知重绘
    if (chunk === '\x7f' || chunk === '\x08') {
      if (cursor > 0) {
        chars.splice(cursor - 1, 1);
        cursor--;
        redraw();
      }
      return;
    }
    // Delete（\x1b[3~）：删除光标后一个字符
    if (chunk === '\x1b[3~') {
      if (cursor < chars.length) {
        chars.splice(cursor, 1);
        redraw();
      }
      return;
    }

    // 普通输入：粘贴多行时 \r 转 \n（粘贴模式下 \r 是换行，非粘贴模式下 \r 也是换行）
    const text = chunk.replace(/\r/g, '\n');
    const newChars = Array.from(text);  // 按 code point 分割
    if (cursor === chars.length) {
      // 光标在末尾：追加 O(1)，只 echo 新字符，不重绘整行（超长行不卡的关键）
      chars.push(...newChars);
      cursor = chars.length;
      process.stdout.write(text);
      // 追加可能触发折行，更新渲染行数
      renderedLines = contentLines();
    } else {
      // 光标在中间：插入 + 重绘整行
      chars.splice(cursor, 0, ...newChars);
      cursor += newChars.length;
      redraw();
    }
  });

  return {
    setBusy(busy: boolean): void {
      if (busy) {
        process.stdin.pause();
      } else {
        process.stdin.resume();
      }
    },

    readLine(): Promise<string> {
      return new Promise(resolve => {
        resolveLine = resolve;
        chars = [];
        cursor = 0;
        renderedLines = 1;
        process.stdout.write(PROMPT);
      });
    },

    renderResult(text: string, ms: number, inputTokens?: number, outputTokens?: number): void {
      const s = (ms / 1000).toFixed(1);
      const tok = inputTokens != null ? ` | in: ${inputTokens}, out: ${outputTokens}` : '';
      safeWrite(`\n${mdToANSI(text)}\n[${s}s${tok}]`);
    },

    renderError(err: string): void {
      process.stdout.write(`Error: ${err}\n`);
    },

    startRender(engine: { events: Array<{ type: string; [key: string]: unknown }> }): () => void {
      isFirstThinking = true;  // 每次新查询，重置"第一个 thinking 不换行"标志
      return pollEvents(engine, renderProgress);
    },

    showHelp(toolNames: string[]): void {
      process.stdout.write(`Tools: ${toolNames.join(', ')}\nCommands: /exit, /help\n`);
    },

    close(): void {
      closed = true;
      // 关闭 bracketed paste + 恢复 raw mode，避免退出后终端状态残留
      process.stdout.write('\x1b[?2004l');
      if (typeof process.stdin.setRawMode === 'function') {
        try { process.stdin.setRawMode(false); } catch { /* 忽略 */ }
      }
      process.stdout.write('Bye.\n');
      process.exit(0);
    },
  };
}
