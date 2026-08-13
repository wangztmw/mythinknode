/**
 * CLI — 统一 stdout 渲染，readline 仅接收输入。
 *
 * 宽度自适应：
 *   ≥60列 → \r 原地覆写（正常体验）
 *   <60列 → 仅显示首帧+尾帧（防止 \r+ANSI 折行 + 刷屏）
 */
import { createInterface } from 'node:readline';
import type { ProgressEvent, MergedTool } from './monitor/progress.js';
import { pollEvents } from './monitor/progress.js';
import { mdToANSI, B, b, C, c } from './render/ansi.js';
import { safeWrite, displayWidth } from './render/term-wrap.js';

const THINKING_PHASES = new Set(['analyzing', 'continuing', 'reviewing results', 'summarizing agent results', 'processing']);

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

function renderProgress(event: ProgressEvent): void {
  try {
    const cols = process.stdout.columns || 80;
    const wide = cols >= 60;

    switch (event.type) {
      case 'thinking_start': {
        const name = phaseLabel(event.label);
        process.stdout.write(`\n  ● ${B}${name}${b} (0.0s) — ${trunc(event.label, cols - 25)}\x1b[K`);
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
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const PROMPT = `${C}${B}mythinknode${b}${c} ${B}>>>${b} `;
  rl.setPrompt(PROMPT);

  let resolveLine: ((value: string) => void) | null = null;
  let drainTimer: ReturnType<typeof setInterval> | null = null;

  rl.on('line', (line: string) => {
    if (resolveLine) {
      resolveLine(line.trim());
      resolveLine = null;
    }
  });

  return {
    setBusy(busy: boolean): void {
      if (busy) {
        rl.pause();
        process.stdout.write('\n');
        drainTimer = setInterval(() => {
          while (process.stdin.read() !== null) { /* drain IME */ }
        }, 100);
      } else {
        if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
        rl.resume();
      }
    },

    readLine(): Promise<string> {
      return new Promise(resolve => {
        resolveLine = resolve;
        rl.prompt();
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
      return pollEvents(engine, renderProgress);
    },

    showHelp(toolNames: string[]): void {
      process.stdout.write(`Tools: ${toolNames.join(', ')}\nCommands: /exit, /help\n`);
    },

    close(): void {
      rl.close();
      process.stdout.write('Bye.\n');
      process.exit(0);
    },
  };
}
