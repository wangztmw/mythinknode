/**
 * 输出渲染器 — 消费 ProgressEvent，把引擎事件渲染成 ANSI。
 * 与输入层（input-buffer）完全解耦；所有终端写入经 ScreenStateLike（主屏 / 备用屏两模式）。
 */
import type { ProgressEvent, MergedTool } from '../../agent/progress.js';
import type { RuntimeState } from '../../agent/runtime_state.js';
import { createSampler } from '../tui/observe.js';
import { mdToANSI, B, b, C, c } from './ansi.js';
import { displayWidth, charWidth, wrapLine } from './term-wrap.js';
import type { ScreenStateLike } from './types.js';

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

function renderProgress(event: ProgressEvent, ss: ScreenStateLike): void {
  try {
    const cols = ss.cols;
    const wide = cols >= 60;

    switch (event.type) {
      case 'thinking_end': {
        // 一次性的历史事实：这一段花了多久 + 产出几个工具。
        // 状态行的「实时秒数」不再由事件驱动（改由观察者采样 + 自己算，见 observe.ts）。
        const raw = event.elapsedMs / 1000;
        const sec = raw < 0.1 ? '<0.1' : raw.toFixed(1);
        const hint = event.toolCount > 0 ? ` → ${event.toolCount} tool${event.toolCount > 1 ? 's' : ''}` : '';
        ss.endStatus(`  ● ${B}${phaseLabel(event.label)}${b} (${sec}s)${hint}`);
        break;
      }
      case 'thought': {
        const ansi = mdToANSI(event.text.slice(0, 300));
        ss.writeLines(`  ${ansi}`);  // 经 writeLines 折行，避免超长 thought 触发 Terminal 崩溃
        break;
      }
      case 'notice': {
        const icon = event.kind === 'budget' ? '⏳' : '🔁';
        const line = `${icon} ${event.text.split('\n')[0]}`;
        for (const row of wrapLine(line, cols)) ss.writeLines(`  ${C}${row}${c}`);
        break;
      }
      case 'tool_display': {
        // 首行替换 tick 的状态行（"● Bash (0.0s)"），其余行正常追加；每行折行避免超长（工具 sample 可能多行）
        const text = renderMergedTools(event.calls, event.elapsedMs, cols);
        const lines: string[] = [];
        for (const line of text.split('\n')) {
          for (const row of wrapLine(line, cols)) lines.push(row);
        }
        ss.displayTools(lines);
        break;
      }
      case 'error':
        ss.writeLines(`  ✗ ${event.message}`);  // 经 writeLines 折行，避免超长 error 触发 Terminal 崩溃
        break;
    }
  } catch { /* 渲染不应崩 */ }
}

function renderMergedTools(merged: MergedTool[], elapsedMs: number | undefined, cols: number): string {
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

export function createRenderer(ss: ScreenStateLike) {
  return {
    renderResult(text: string, ms: number, inputTokens?: number, outputTokens?: number): void {
      const s = (ms / 1000).toFixed(1);
      const tok = inputTokens != null ? ` | in: ${inputTokens}, out: ${outputTokens}` : '';
      ss.writeLines(`\n${mdToANSI(text)}\n[${s}s${tok}]`);
    },

    renderError(err: string): void {
      ss.writeLines(`Error: ${err}`);
    },

    startRender(engine: {
      onEvent: (listener: (e: ProgressEvent) => void) => () => void;
      snapshot: () => RuntimeState;
    }): () => void {
      isFirstThinking = true;  // 每次新查询，重置"第一个 thinking 不换行"标志

      // ★ 观察者（眼睛）：classic 路径同样用采样器，而不是等 agent 每秒播报。
      // 时间由这里现算（now - startedAt），agent 卡住时数字照涨 → 卡顿可见。
      const sampler = createSampler(engine);
      let renderedKey = '';
      let statusActive = false;
      const unsubObserve = sampler.subscribe(obs => {
        const { state, now } = obs;
        if (state.phase === 'idle') {
          if (statusActive) { ss.endStatus(''); statusActive = false; renderedKey = ''; }
          return;
        }
        const cols = ss.cols;
        const startedAt = state.tool?.startedAt ?? state.phaseStartedAt;
        const sec = ((now - startedAt) / 1000).toFixed(1);
        const isThinking = state.phase === 'thinking';
        const main = isThinking ? 'Thinking' : (state.tool?.name ?? state.label);
        const detail = isThinking ? ` — ${trunc(state.label, cols - 25)}` : '';
        // 不做「可能卡住/仍在进行」判断：状态不变既可能是 sleep 30（正常）也可能是死锁，
        // 这个信号没有区分力。秒数本身已经说明「过了多久」。
        const content = `  ● ${B}${main}${b} (${sec}s)${detail}`;

        // 只在内容真的变了时重绘（观察者自己决定节奏，不打断 ss 的其它输出）
        const key = `${main}|${detail}|${sec}`;
        if (key === renderedKey) return;
        renderedKey = key;
        const leadingNewline = !statusActive && !isFirstThinking;
        if (!statusActive) { isFirstThinking = false; ss.beginStatus(content, leadingNewline); statusActive = true; }
        else ss.overwriteStatus(content);
      });

      const unsub = engine.onEvent((e: ProgressEvent) => {
        // thinking_end 落成永久行后，状态行交还给采样器
        if (e.type === 'thinking_end' && statusActive) { statusActive = false; renderedKey = ''; }
        try { renderProgress(e, ss); } catch { /* 渲染不应崩 */ }
      });

      return () => {
        unsubObserve();
        sampler.dispose();
        unsub();
        if (statusActive) { try { ss.endStatus(''); } catch { /* 忽略 */ } }
      };
    },

    showHelp(toolNames: string[]): void {
      ss.writeLines(`Tools: ${toolNames.join(', ')}`);
      ss.writeLines(`Commands: /exit, /help, /local, /cloud`);
    },
  };
}
