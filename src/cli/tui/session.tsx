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
import { TuiStore, type LogKind, type LogMeta } from './store.js';
import { SessionApp } from './SessionApp.js';
import { collectSnapshot } from './data.js';
import { WindowSizeProvider } from './layout/window-size.js';
import { createSampler } from './observe.js';
import { historyToBlocks } from '../../session/session_history.js';
import type { ChatMessage } from '../../llm/types.js';
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

interface EngineEvents {
  onEvent(listener: (event: ProgressEvent) => void): () => void;
}

/** 观察者的眼睛需要「读快照」能力；不强依赖 AgentEngine 具体类型，便于测试 */
interface Observable {
  snapshot(): import('../../agent/runtime_state.js').RuntimeState;
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

  // provider 必须包在 render 的根位置（SessionApp 自己要用尺寸）。
  // 这里同时也保证 <Static> 里每条日志项（ToolLine/MarkdownBlock/…）都从
  // context 读尺寸，而不是各自挂 resize 监听器。
  const instance = render(
    <WindowSizeProvider>
      <SessionApp store={store} />
    </WindowSizeProvider>,
    {
      exitOnCtrlC: false,       // Ctrl+C 由 SessionApp 统一处理（保留退出前清理）
      incrementalRendering: true, // 只重绘变化行：长输入/高频输入时显著降低终端写入压力
    },
  );

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

    startRender(engine: EngineEvents & Observable): () => void {
      // ★ 观察者（眼睛）：独立采样 engine 的快照，agent 不知道它在看。
      // 状态行的时间由渲染层现算（status.tsx 的 formatStatus），不来自 agent。
      const sampler = createSampler(engine);
      const unsubObserve = sampler.subscribe((obs) => {
        const { state } = obs;
        if (state.phase === 'idle') { store.setStatus(null); return; }
        const isThinking = state.phase === 'thinking';
        store.setStatus({
          main: isThinking ? 'Thinking' : (state.tool?.name ?? state.label),
          detail: isThinking ? state.label : '',
          startedAt: state.tool?.startedAt ?? state.phaseStartedAt,
        });
      });

      const unsubscribe = engine.onEvent((event: ProgressEvent) => {
        switch (event.type) {
          case 'thinking_end': {
            // 一次性的历史事实（这一段花了多久、产出几个工具）仍需落成永久日志行，
            // 但它不再驱动状态行 —— 状态行由采样器接管。
            const hint = event.toolCount > 0
              ? ` → ${event.toolCount} tool${event.toolCount > 1 ? 's' : ''}`
              : '';
            store.append('system', `${phaseLabel(event.label)} ${seconds(event.elapsedMs)}s${hint}`);
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
          case 'notice': {
            const icon = event.kind === 'budget' ? '⏳' : '🔁';
            store.append('system', `${icon} ${event.text.split('\n')[0]}`);
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
        unsubObserve();
        sampler.dispose();
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

    /**
     * 恢复会话时重放历史对话：用户发言 + assistant 文本 + 工具名。
     * 重放规则与 classic 版共用 historyToBlocks()，这里只做 store 写入。
     */
    restoreHistory(messages: ChatMessage[]): void {
      const blocks = historyToBlocks(messages);
      if (blocks.length === 0) return;
      const items: Array<{ kind: LogKind; text: string; meta?: LogMeta }> = [
        { kind: 'system', text: '── 历史对话 ──' },
      ];
      for (const block of blocks) {
        if (block.kind === 'user') {
          items.push({ kind: 'user', text: sanitizeOutput(block.text) });
        } else if (block.kind === 'md') {
          items.push({ kind: 'md', text: sanitizeOutput(block.text) });
        } else {
          items.push({ kind: 'tool', text: block.text, meta: { name: block.text, args: '' } });
        }
      }
      items.push({ kind: 'system', text: '── 以上为历史，以下继续 ──' });
      store.appendBatch(items);
    },

    /**
     * 注册/清除中断处理器。
     *
     * 主循环在一轮执行开始时注册（ESC/Ctrl+C → 打断这一轮），
     * 一轮结束时清除（此时 Ctrl+C 恢复「退出」语义）。
     */
    setInterruptHandler(fn: (() => boolean) | null): void {
      store.interruptHandler = fn;
    },

    close(): void {
      store.forceExit();
    },
  };
}
