/**
 * 输出渲染器 — 消费 ProgressEvent，把引擎事件渲染成 ANSI。
 * 与输入层（input-buffer）完全解耦。对外只暴露 renderResult/renderError/startRender/showHelp。
 */
import type { ProgressEvent, MergedTool } from '../../agent/progress.js';
import { mdToANSI, B, b } from './ansi.js';
import { safeWrite, displayWidth, charWidth, wrapLine } from './term-wrap.js';

const THINKING_PHASES = new Set(['analyzing', 'continuing', 'reviewing results', 'summarizing agent results', 'processing']);

// 每次 runSession 的第一个 thinking 不换行（紧接用户输入行），后续 thinking 才换行
let isFirstThinking = true;

/** CJK 双宽感知截断（用 charWidth，与输入层/终端宽度计算同一套，避免 FFE0-FFE6 全角符号漏判） */
function trunc(s: string, maxCols: number): string {
  if (displayWidth(s) <= maxCols) return s;
  let visible = 0, cut = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\x1b') { while (i < s.length && s[i] !== 'm') i++; continue; }
    visible += charWidth(s[i]);
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
        const pfx = isFirstThinking ? '' : '\n';
        isFirstThinking = false;
        process.stdout.write(`${pfx}  ● ${B}${name}${b} (0.0s) — ${trunc(event.label, cols - 25)}\x1b[K`);
        break;
      }
      case 'thinking_tick': {
        // 窄终端：只显示首帧，抑制中间 tick 防止刷屏
        if (!wide) break;
        const s = (event.elapsedMs / 1000).toFixed(1);
        const isThinking = phaseLabel(event.label) === 'Thinking';
        const name = trunc(phaseLabel(event.label), cols - 15);  // 工具名可能很长（多工具列表），截断防超长
        const desc = isThinking ? ` — ${trunc(event.label, cols - 25)}` : '';
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
        safeWrite(`  ${ansi}`);  // 经 safeWrite 折行，避免超长 thought 触发 Terminal 崩溃
        break;
      }
      case 'tool_display': {
        // 首行 \r 覆盖 tick 的状态行（"● Bash (0.0s)"），其余行正常换行；每行折行避免超长（工具 sample 可能多行）
        const text = renderMergedTools(event.calls, event.elapsedMs);
        let first = true;
        for (const line of text.split('\n')) {
          for (const row of wrapLine(line, cols)) {
            process.stdout.write(`${first ? '\r' : ''}${row}\x1b[K\n`);
            first = false;
          }
        }
        break;
      }
      case 'error':
        safeWrite(`  ✗ ${event.message}`);  // 经 safeWrite 折行，避免超长 error 触发 Terminal 崩溃
        break;
    }
  } catch { /* 渲染不应崩 */ }
}

function renderMergedTools(merged: MergedTool[], elapsedMs?: number): string {
  const cols = process.stdout.columns || 80;
  const parts: string[] = [];
  for (const m of merged) {
    const label = m.count > 1 ? `${m.name} ×${m.count}` : m.name;
    const params = m.inputs.join(', ');
    const info = m.count > 1 ? `(${m.lines} lines total)` : `→ ${m.sample}`;
    const time = elapsedMs != null ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
    const rest = `${time}: ${params}  ${info}`;
    parts.push(`  ● ${B}${label}${b}${trunc(rest, cols - 10)}`);
  }
  return parts.join('\n');
}

export function createRenderer() {
  return {
    renderResult(text: string, ms: number, inputTokens?: number, outputTokens?: number): void {
      const s = (ms / 1000).toFixed(1);
      const tok = inputTokens != null ? ` | in: ${inputTokens}, out: ${outputTokens}` : '';
      safeWrite(`\n${mdToANSI(text)}\n[${s}s${tok}]`);
    },

    renderError(err: string): void {
      safeWrite(`Error: ${err}`);
    },

    startRender(engine: { onEvent: (listener: (e: ProgressEvent) => void) => () => void }): () => void {
      isFirstThinking = true;  // 每次新查询，重置"第一个 thinking 不换行"标志
      let pendingTick: ProgressEvent | null = null;
      let tickTimer: ReturnType<typeof setInterval> | null = null;

      const flushTick = () => {
        if (!pendingTick) return;
        const t = pendingTick; pendingTick = null;
        try { renderProgress(t); } catch { /* 渲染不应崩 */ }
      };

      const unsub = engine.onEvent((e: ProgressEvent) => {
        if (e.type === 'thinking_tick') { pendingTick = e; return; } // 连续 tick 只保留最后一条
        flushTick(); // 非 tick 事件前先刷 tick，保持时间顺序（否则 tick 会插到 thinking_end 之后重复一行）
        try { renderProgress(e); } catch { /* 渲染不应崩 */ }
      });

      // 镜像旧 pollEvents 的 1s 残量刷新：没有后续非 tick 事件时，也要把最后的 tick 刷出来
      tickTimer = setInterval(flushTick, 1000);

      return () => {
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
        flushTick();
        unsub();
      };
    },

    showHelp(toolNames: string[]): void {
      safeWrite(`Tools: ${toolNames.join(', ')}`);
      safeWrite(`Commands: /exit, /help`);
    },
  };
}
