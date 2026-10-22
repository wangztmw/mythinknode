/**
 * 交互式会话 TUI — 只做组件编排。
 * 文本宽度/折行/断点/限制在 text/ 与 layout/；各输出块在 render/。
 */
import React, { useSyncExternalStore } from 'react';
import { appendFileSync } from 'node:fs';
import { Box, Static, Text, useCursor, useInput, usePaste, useWindowSize } from 'ink';
import { TuiStore, type LogItem } from './store.js';
import { colors } from './theme.js';
import { getBreakpoint } from './layout/breakpoints.js';
import { computeInputGeometry } from './layout/geometry.js';
import { hintText, inputLines } from './layout/limits.js';
import { cursorLineColumn, wrapLines } from './text/wrap.js';
import { truncateToWidth } from './text/width.js';
import { ErrorBoundary } from './render/ErrorBoundary.js';
import { WelcomeItem } from './render/welcome.js';
import { MarkdownBlock } from './render/markdown.js';
import { ThoughtBlock } from './render/thought.js';
import { ToolLine, ToolResult } from './render/tool.js';
import { SystemLine, ThinkingStatus } from './render/status.js';

const PROMPT = '› ';

// ---- 可选输入诊断（MYTHINKNODE_DEBUG_INPUT=1）----
const DEBUG_INPUT = process.env.MYTHINKNODE_DEBUG_INPUT === '1';
const DEBUG_LOG = '/tmp/mythinknode-tui-input.log';
let debugSeq = 0;

function debugInput(kind: string, text: string, total: number): void {
  if (!DEBUG_INPUT) return;
  debugSeq++;
  try {
    appendFileSync(
      DEBUG_LOG,
      `${new Date().toISOString()} #${debugSeq} ${kind} chunk=${text.length} total=${total}\n`,
    );
  } catch { /* 诊断日志失败不影响输入 */ }
}

// ============================================================
// 日志行
// ============================================================
function LogLine({ item }: { item: LogItem }) {
  switch (item.kind) {
    case 'welcome':
      return <WelcomeItem item={item} />;

    case 'user':
      return (
        <Box marginTop={1} flexDirection="row">
          <Text color={colors.gray}>{'> '}</Text>
          <Box flexGrow={1}><Text bold color={colors.text}>{item.text}</Text></Box>
        </Box>
      );

    case 'md':
      return <MarkdownBlock text={item.text} />;

    case 'tool':
      return <ToolLine item={item} />;

    case 'toolResult':
      return <ToolResult item={item} />;

    case 'thought':
      return <ThoughtBlock item={item} />;

    case 'error':
      return <Text color={colors.error}>✗ {item.text}</Text>;

    case 'help':
      return <Text color={colors.accent}>{item.text}</Text>;

    case 'system':
    default:
      return <SystemLine item={item} />;
  }
}

// ============================================================
// 输入框
// ============================================================
interface InputView {
  lines: string[];
  start: number;
  totalLines: number;
  cursorLine: number;
  cursorCol: number;
  hasAbove: boolean;
  hasBelow: boolean;
}

function computeInputView(
  value: string,
  cursor: number,
  textWidth: number,
  rows: number,
): InputView {
  const allLines = wrapLines(value, textWidth);
  const { line: cursorLine, col: cursorCol } = cursorLineColumn(value, cursor, textWidth);
  const maxLines = inputLines(rows);

  let start = 0;
  if (allLines.length > maxLines) {
    start = Math.min(
      Math.max(0, cursorLine - Math.floor(maxLines / 2)),
      allLines.length - maxLines,
    );
  }

  return {
    lines: allLines.slice(start, start + maxLines),
    start,
    totalLines: allLines.length,
    cursorLine,
    cursorCol,
    hasAbove: start > 0,
    hasBelow: start + maxLines < allLines.length,
  };
}

function InputBox({ value, cursor }: { value: string; cursor: number }) {
  const { columns, rows } = useWindowSize();
  const bp = getBreakpoint(columns, rows);
  const geometry = computeInputGeometry(columns, bp);
  const view = computeInputView(value, cursor, geometry.textWidth, rows);
  const { setCursorPosition } = useCursor();

  const contentRow = geometry.inputY + (view.hasAbove ? 1 : 0);
  setCursorPosition({
    x: geometry.inputX + view.cursorCol,
    y: contentRow + (view.cursorLine - view.start),
  });

  const aboveLabel = bp.narrow ? `+${view.start}` : `还有 ${view.start} 行`;
  const belowCount = view.totalLines - view.start - view.lines.length;
  const belowLabel = bp.narrow ? `+${belowCount}` : `还有 ${belowCount} 行`;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        borderStyle="round"
        borderColor={colors.accent}
        paddingX={geometry.paddingX}
        width="100%"
      >
        <Box width={geometry.promptWidth} flexShrink={0}>
          <Text color={colors.accent} bold>{PROMPT}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {value.length === 0
            ? (
              <Text color={colors.gray} wrap="truncate-end">
                {truncateToWidth('Try “解释这个仓库的结构”', geometry.textWidth)}
              </Text>
            )
            : (
              <>
                {view.hasAbove && <Text color={colors.gray}>↑ {aboveLabel}</Text>}
                {view.lines.map((line, i) => (
                  <Text key={view.start + i} wrap="truncate-end">{line || ' '}</Text>
                ))}
                {view.hasBelow && <Text color={colors.gray}>↓ {belowLabel}</Text>}
              </>
            )}
        </Box>
      </Box>
      <Box justifyContent="space-between" marginTop={0}>
        <Text color={colors.gray}>{hintText(bp)}</Text>
        {!bp.narrow && <Text color={colors.gray}>Ctrl+C 退出</Text>}
      </Box>
    </Box>
  );
}

// ============================================================
// App
// ============================================================
export function SessionApp({ store }: { store: TuiStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useInput((input, key) => {
    if (input) debugInput('key', input, state.input.length);
    if (key.ctrl && (input === 'c' || input === 'd')) {
      store.forceExit();
      return;
    }
    if (!state.waiting) return;

    if (key.return) store.submit();
    else if (key.leftArrow) store.moveLeft();
    else if (key.rightArrow) store.moveRight();
    else if (key.home) store.moveHome();
    else if (key.end) store.moveEnd();
    else if (key.upArrow) store.historyPrev();
    else if (key.downArrow) store.historyNext();
    else if (key.backspace) store.backspace();
    else if (key.delete) store.deleteForward();
    else if (key.ctrl && input === 'u') store.clearLine();
    else if (key.ctrl && input === 'w') store.deleteWord();
    else if (input) {
      // 终端/输入法可能把整段文本连同回车合并成一个 chunk 送达。
      // 只有「恰好一个结尾换行」才视为回车提交；多行内容原样插入，避免丢字。
      const newlineCount = (input.match(/[\r\n]/g) || []).length;
      const endsWithNewline = /[\r\n]$/.test(input);
      const body = input.replace(/[\r\n]/g, '');
      if (body === '') {
        store.submit();
      } else if (endsWithNewline && newlineCount === 1) {
        store.insert(input.slice(0, -1));
        store.submit();
      } else {
        store.insert(input);
      }
    }
  });

  // 粘贴整段文本（含换行），避免被拆成回车提前提交
  usePaste((text) => {
    debugInput('paste', text, state.input.length);
    if (state.waiting) store.insert(text);
  }, { isActive: state.waiting });

  return (
    <Box flexDirection="column">
      <Static items={state.log}>
        {(item: LogItem) => (
          <ErrorBoundary key={item.id} label={item.kind}>
            <LogLine item={item} />
          </ErrorBoundary>
        )}
      </Static>

      {state.busy && (
        <ErrorBoundary label="status">
          <ThinkingStatus status={state.status ?? 'Working…'} />
        </ErrorBoundary>
      )}

      {state.waiting && (
        <ErrorBoundary label="input">
          <InputBox value={state.input} cursor={state.cursor} />
        </ErrorBoundary>
      )}
    </Box>
  );
}
