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
import { OutputBuffer } from './output-buffer.js';

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

/** 把 thinking 事件转成状态行字符串（thinking_start/tick/end 显示在输入行上方，不进历史） */
function renderStatusLine(event: ProgressEvent): string {
  const cols = process.stdout.columns || 80;
  const wide = cols >= 60;
  switch (event.type) {
    case 'thinking_start': {
      const name = phaseLabel(event.label);
      return `  ● ${B}${name}${b} (0.0s) — ${trunc(event.label, cols - 25)}`;
    }
    case 'thinking_tick': {
      if (!wide) return '';
      const s = (event.elapsedMs / 1000).toFixed(1);
      const name = phaseLabel(event.label);
      const desc = name === 'Thinking' ? ` — ${trunc(event.label, cols - 25)}` : '';
      return `  ● ${B}${name}${b} (${s}s)${desc}`;
    }
    case 'thinking_end': {
      const raw = event.elapsedMs / 1000;
      const s = raw < 0.1 ? '<0.1' : raw.toFixed(1);
      const hint = event.toolCount > 0 ? ` → ${event.toolCount} tool${event.toolCount > 1 ? 's' : ''}` : '';
      return `  ● ${B}Thinking${b} (${s}s) — ${trunc(event.label, cols - 25)}${hint}`;
    }
    default:
      return '';
  }
}

/** 把 thought/tool/error 事件转成历史行文本（多行），供 buffer.append */
function renderEventLines(event: ProgressEvent): string {
  const cols = process.stdout.columns || 80;
  const wide = cols >= 60;
  switch (event.type) {
    case 'thought': {
      const ansi = mdToANSI(event.text.slice(0, 300));
      return `  ${wide ? ansi : trunc(ansi, cols - 4)}`;
    }
    case 'tool_display':
      return renderMergedToolsText(event.calls, event.elapsedMs);
    case 'error':
      return `  ✗ ${event.message}`;
    default:
      return '';
  }
}

function renderMergedToolsText(merged: MergedTool[], elapsedMs?: number): string {
  const cols = process.stdout.columns || 80;
  const wide = cols >= 60;
  const pfx = wide ? '\r' : '\n';
  let out = '';
  for (const m of merged) {
    const label = m.count > 1 ? `${m.name} ×${m.count}` : m.name;
    const params = m.inputs.join(', ');
    const info = m.count > 1 ? `(${m.lines} lines total)` : `→ ${m.sample}`;
    const time = elapsedMs != null ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
    const rest = `${time}: ${params}  ${info}`;
    out += `${pfx}  ● ${B}${label}${b}${trunc(rest, cols - 10)}`;
  }
  return out;
}

// ---- REPL ----

export function createCLI() {
  // 自建内容管理 + 备用屏接管：raw mode + 自管 stdin + 全屏重绘。
  //
  // 为什么不用 readline：
  //   - terminal: true  → IME 正常，但超长单行 O(n²) 逐字符回显重绘卡死（实测 5 万字卡死）
  //   - terminal: false → 超长行 O(1)，但 canonical mode 破坏 IME composition 状态机 → 中文输入卡死
  //
  // 备用屏 + 全屏重绘：程序完全控制屏幕内容，历史进内存缓冲，屏幕只显示简单可视窗口，
  // 从源头避开 Terminal.app 渲染层的 malloc 崩溃（5 份崩溃报告佐证）。
  const PROMPT = `${C}${B}mythinknode${b}${c} ${B}>>>${b} `;

  let resolveLine: ((value: string) => void) | null = null;
  // 字符数组（按 code point 分割，正确处理中文双宽 + emoji 代理对）
  let chars: string[] = [];
  // 光标位置（chars 索引，指向两个字符之间）
  let cursor = 0;
  // bracketed paste 状态：粘贴中 = true。粘贴内容里的 \r 是换行，不是回车提交。
  let inPaste = false;
  let closed = false;
  // 状态行（thinking/tool 进度），显示在输入行上方，不进历史。空串 = 无状态行。
  let statusLine = '';
  // 输入防抖定时器（打字防抖 100ms 后再全屏重绘，降低重绘频率）
  let inputDebounce: ReturnType<typeof setTimeout> | null = null;
  // 历史输出缓冲
  const buffer = new OutputBuffer();

  // 进入 raw mode（保 IME composition 状态机）
  if (typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
  }
  process.stdin.setEncoding('utf8');
  // 备用屏 + bracketed paste + SGR 鼠标模式
  process.stdout.write('\x1b[?1049h');   // 进备用屏
  process.stdout.write('\x1b[?2004h');   // bracketed paste
  process.stdout.write('\x1b[?1000h\x1b[?1006h');  // SGR 鼠标（滚轮事件）

  /** 输入行占用的屏幕行数（含 PROMPT，考虑折行 + 显式 \n + 双宽） */
  const inputLineCount = () => {
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

  /** 光标在输入行内的行列（line 从输入行第一行=0 起，col 是该行显示列） */
  const cursorPos = () => {
    const cols = process.stdout.columns || 80;
    const promptW = displayWidth(PROMPT);
    let line = 0, col = promptW;
    for (let i = 0; i < cursor; i++) {
      const c = chars[i];
      if (c === '\n') { line++; col = 0; continue; }
      const w = charWidth(c);
      if (col + w > cols) { line++; col = w; }
      else { col += w; }
    }
    return { line, col };
  };

  /** 主动折行输入内容（从 prompt 后开始），超宽处插 \n，让终端不做软折行 */
  const foldInput = () => {
    const cols = process.stdout.columns || 80;
    const promptW = displayWidth(PROMPT);
    let col = promptW;
    let out = '';
    for (const c of chars) {
      if (c === '\n') { out += '\n'; col = 0; continue; }
      const w = charWidth(c);
      if (col + w > cols) { out += '\n' + c; col = w; }
      else { out += c; col += w; }
    }
    return out;
  };

  /** 全屏重绘统一入口：清屏 → 历史可视窗口 → 状态行 → 输入行 → 光标定位 */
  const render = () => {
    if (closed) return;
    const rows = process.stdout.rows || 24;
    const inputLines = inputLineCount();
    const statusLines = statusLine ? 1 : 0;
    // 历史区高度 = 总行数 - 输入行数 - 状态行数
    const histHeight = Math.max(1, rows - inputLines - statusLines);

    const histLines = buffer.visible(histHeight);
    const foldedInput = foldInput();
    const { line: curLine, col: curCol } = cursorPos();

    let out = '\x1b[2J\x1b[H';  // 清屏 + 光标回左上角
    // 1. 历史可视窗口
    for (const l of histLines) out += l + '\r\n';
    // 2. 状态行
    if (statusLine) out += statusLine + '\r\n';
    // 3. 输入行（折行后）
    out += PROMPT + foldedInput;
    // 4. 光标定位：从输入行末尾上移回 cursor 所在行，\r 回行首，绝对列定位到 col
    const upToCursor = inputLines - 1 - curLine;
    if (upToCursor > 0) out += `\x1b[${upToCursor}A`;
    out += '\r';
    out += `\x1b[${curCol + 1}G`;  // 绝对列定位（1-based），不用相对右移
    process.stdout.write(out);
  };

  /** 打字防抖：停止输入 100ms 后才全屏重绘（编辑操作则立即重绘） */
  const scheduleRender = () => {
    if (inputDebounce) clearTimeout(inputDebounce);
    inputDebounce = setTimeout(render, 100);
  };

  const settle = () => {
    if (!resolveLine) return;
    const text = cleanInput(chars.join('').trim());
    // 把用户这行输入追加进历史（这样回车后内容不丢）
    if (text) buffer.append(PROMPT + text);
    chars = [];
    cursor = 0;
    statusLine = '';
    const resolve = resolveLine;
    resolveLine = null;
    render();  // 立即重绘：历史含用户输入，输入行清空
    resolve(text);
  };

  process.stdin.on('data', (chunk: string) => {
    if (closed) return;
    // SGR 鼠标滚轮：\x1b[<64;...M（上）/ \x1b[<65;...M（下）→ 滚动历史
    if (chunk.startsWith('\x1b[<64;')) { buffer.scroll(-3); render(); return; }
    if (chunk.startsWith('\x1b[<65;')) { buffer.scroll(3); render(); return; }
    // Ctrl+C (0x03) 退出
    if (chunk === '\x03') { process.stdout.write('\nBye.\n'); process.exit(0); }
    // bracketed paste 开始标记：进入粘贴模式，后面的 \r 都是内容换行
    if (chunk.includes('\x1b[200~')) {
      inPaste = true;
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
      return;
    }
    // 方向键左/右 —— 移动光标，立即重绘（编辑操作需即时反馈）
    if (chunk === '\x1b[D') {
      if (cursor > 0) { cursor--; render(); }
      return;
    }
    if (chunk === '\x1b[C') {
      if (cursor < chars.length) { cursor++; render(); }
      return;
    }
    // Home / End
    if (chunk === '\x1b[H' || chunk === '\x1b[1~') { cursor = 0; render(); return; }
    if (chunk === '\x1b[F' || chunk === '\x1b[4~') { cursor = chars.length; render(); return; }
    // 退格（Backspace 0x7f 或 0x08）
    if (chunk === '\x7f' || chunk === '\x08') {
      if (cursor > 0) {
        chars.splice(cursor - 1, 1);
        cursor--;
        render();
      }
      return;
    }
    // Delete（\x1b[3~）：删除光标后一个字符
    if (chunk === '\x1b[3~') {
      if (cursor < chars.length) {
        chars.splice(cursor, 1);
        render();
      }
      return;
    }

    // 普通输入：粘贴多行时 \r 转 \n
    const text = chunk.replace(/\r/g, '\n');
    const newChars = Array.from(text);  // 按 code point 分割
    if (cursor === chars.length) {
      chars.push(...newChars);
      cursor = chars.length;
      scheduleRender();  // 打字防抖 100ms 后重绘
    } else {
      chars.splice(cursor, 0, ...newChars);
      cursor += newChars.length;
      render();  // 中间插入立即重绘
    }
  });

  return {
    banner(lines: string[]): void {
      for (const l of lines) buffer.append(l);
      render();
    },

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
        statusLine = '';
        render();
      });
    },

    renderResult(text: string, ms: number, inputTokens?: number, outputTokens?: number): void {
      const s = (ms / 1000).toFixed(1);
      const tok = inputTokens != null ? ` | in: ${inputTokens}, out: ${outputTokens}` : '';
      // 最终结果进历史缓冲，然后重绘
      buffer.append(mdToANSI(text));
      buffer.append(`[${s}s${tok}]`);
      statusLine = '';
      render();
    },

    renderError(err: string): void {
      buffer.append(`Error: ${err}`);
      statusLine = '';
      render();
    },

    startRender(engine: { events: Array<{ type: string; [key: string]: unknown }> }): () => void {
      isFirstThinking = true;  // 每次新查询，重置"第一个 thinking 不换行"标志
      return pollEvents(engine, (e) => {
        // thinking 系列进状态行（输入行上方），thought/tool/error 进历史缓冲
        if (e.type === 'thinking_start' || e.type === 'thinking_tick' || e.type === 'thinking_end') {
          statusLine = renderStatusLine(e);
          render();
        } else if (e.type === 'thought' || e.type === 'tool_display' || e.type === 'error') {
          const line = renderEventLines(e);
          if (line) {
            buffer.append(line);
            statusLine = '';
            render();
          }
        }
      });
    },

    showHelp(toolNames: string[]): void {
      buffer.append(`Tools: ${toolNames.join(', ')}`);
      buffer.append('Commands: /exit, /help');
      render();
    },

    close(): void {
      closed = true;
      // 退出备用屏 + 关闭 bracketed paste + 鼠标模式 + 恢复 raw mode
      process.stdout.write('\x1b[?1000l\x1b[?1006l');  // 关鼠标
      process.stdout.write('\x1b[?2004l');            // 关 bracketed paste
      process.stdout.write('\x1b[?1049l');            // 退备用屏
      if (typeof process.stdin.setRawMode === 'function') {
        try { process.stdin.setRawMode(false); } catch { /* 忽略 */ }
      }
      process.stdout.write('Bye.\n');
      process.exit(0);
    },
  };
}
