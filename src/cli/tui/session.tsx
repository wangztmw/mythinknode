/**
 * Ink 会话前端 — 实现与 createCLI() 完全相同的接口：
 *   setBusy / readLine / renderResult / renderError / startRender / showHelp / writeLines / close
 *
 * 主循环只认这 8 个方法，所以切换 UI 不需要改动任何业务逻辑。
 * 本文件只做事件 → LogItem 的适配；布局/截断交给 src/cli/tui/render 与 text。
 */
import React from 'react';
import { render } from 'ink';
import type { ProgressEvent } from '../../agent/progress.js';
import { TuiStore } from './store.js';
import { SessionApp } from './SessionApp.js';
import { collectSnapshot } from './data.js';
import { sanitizeOutput } from './text/sanitize.js';
import { buildPreview } from './text/preview.js';
import {
  THOUGHT_MAX_CHARS,
  THOUGHT_MAX_LINES,
  TOOL_PREVIEW_MAX_CHARS,
  TOOL_PREVIEW_MAX_LINES,
} from './layout/limits.js';

const THINKING_PHASES = new Set([
  'analyzing', 'continuing', 'reviewing results', 'summarizing agent results', 'processing',
]);

function phaseLabel(label: string): string {
  return THINKING_PHASES.has(label) ? 'Thinking' : label;
}

function seconds(ms: number): string {
  return ms / 1000 < 0.1 ? '<0.1' : (ms / 1000).toFixed(1);
}

/** 工具名本身就是 label，不再重复追加 detail */
function statusText(label: string, elapsed: string, hint = ''): string {
  const phase = phaseLabel(label);
  const detail = phase === label ? '' : ` — ${label}`;
  return `${phase} (${elapsed})${detail}${hint}`;
}

interface EngineEvents {
  onEvent(listener: (event: ProgressEvent) => void): () => void;
}

export function createTuiCLI() {
  const store = new TuiStore();

  // 欢迎框：数据来自与主程序相同的私有配置/工具注册表
  try {
    const snap = collectSnapshot();
    store.appendWelcome({
      version: snap.system.version,
      model: snap.config.model,
      provider: snap.config.provider,
      mode: snap.config.local ? '本地推理 (llama-server)' : '云端推理',
      tools: `${snap.tools.length} enabled`,
      cwd: snap.system.cwd.replace(process.env.HOME ?? '', '~'),
      memory: snap.system.memoryPath.replace(process.env.HOME ?? '', '~'),
    });
  } catch { /* 欢迎框失败不应阻止启动 */ }

  const instance = render(<SessionApp store={store} />, {
    exitOnCtrlC: false,       // Ctrl+C 由 SessionApp 统一处理（保留退出前清理）
    incrementalRendering: true, // 只重绘变化行：长输入/高频输入时显著降低终端写入压力
  });

  // 主循环启动时会调用一次 writeLines 打印 banner；TUI 已有欢迎框，跳过它。
  let bannerSkipped = false;

  store.onExit = () => {
    try { instance.unmount(); } finally { process.exit(0); }
  };

  return {
    setBusy(busy: boolean): void {
      store.setBusy(busy);
    },

    readLine(): Promise<string> {
      return store.readLine();
    },

    renderResult(text: string, ms: number, inputTokens?: number, outputTokens?: number): void {
      store.appendBlock('md', sanitizeOutput(text));
      store.appendBlock('system', '', {
        ms,
        in: inputTokens ?? 0,
        out: outputTokens ?? 0,
      });
    },

    renderError(err: string): void {
      store.append('error', `Error: ${sanitizeOutput(err)}`);
    },

    startRender(engine: EngineEvents): () => void {
      const unsubscribe = engine.onEvent((event: ProgressEvent) => {
        switch (event.type) {
          case 'thinking_start':
            store.setStatus(statusText(event.label, '0.0s'));
            break;
          case 'thinking_tick':
            store.setStatus(statusText(event.label, `${(event.elapsedMs / 1000).toFixed(1)}s`));
            break;
          case 'thinking_end': {
            const hint = event.toolCount > 0
              ? ` → ${event.toolCount} tool${event.toolCount > 1 ? 's' : ''}`
              : '';
            store.setStatus(statusText(event.label, `${seconds(event.elapsedMs)}s`, hint));
            break;
          }
          case 'thought': {
            const preview = buildPreview(
              sanitizeOutput(event.text),
              THOUGHT_MAX_LINES,
              THOUGHT_MAX_CHARS,
            );
            if (preview.text) {
              store.appendBlock('thought', preview.text, {
                totalLines: preview.totalLines,
                shownLines: preview.shownLines,
                truncated: preview.truncated,
              });
            }
            break;
          }
          case 'tool_display': {
            const items: Array<Parameters<TuiStore['appendBatch']>[0][number]> = [];
            for (const call of event.calls) {
              const name = call.count > 1 ? `${call.name} ×${call.count}` : call.name;
              const args = sanitizeOutput(call.inputs.join(', '));
              items.push({ kind: 'tool', text: name, meta: { name, args } });

              if (call.count > 1) {
                items.push({
                  kind: 'toolResult',
                  text: `${call.lines} lines total`,
                  meta: { totalLines: call.lines, shownLines: 1, truncated: false },
                });
              } else {
                const preview = call.preview
                  ? { ...call.preview, text: sanitizeOutput(call.preview.text) }
                  : buildPreview(
                    sanitizeOutput(call.sample),
                    TOOL_PREVIEW_MAX_LINES,
                    TOOL_PREVIEW_MAX_CHARS,
                  );
                if (preview.text) {
                  items.push({
                    kind: 'toolResult',
                    text: preview.text,
                    meta: {
                      totalLines: preview.totalLines,
                      shownLines: preview.shownLines,
                      truncated: preview.truncated,
                    },
                  });
                }
              }
            }
            store.appendBatch(items);
            store.setStatus(null);
            break;
          }
          case 'error':
            store.append('error', `✗ ${sanitizeOutput(event.message)}`);
            break;
        }
      });

      return () => {
        unsubscribe();
        store.setStatus(null);
      };
    },

    showHelp(toolNames: string[]): void {
      store.append('help', `Tools: ${toolNames.join(', ')}`);
      store.append('help', 'Commands: /exit, /help, /local, /cloud');
    },

    writeLines(text: string): void {
      // 启动 banner 与欢迎框重复，跳过第一条
      if (!bannerSkipped && text.trimStart().startsWith('mythinknode v')) {
        bannerSkipped = true;
        return;
      }
      store.append('system', sanitizeOutput(text));
    },

    close(): void {
      store.forceExit();
    },
  };
}
