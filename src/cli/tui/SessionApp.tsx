/**
 * 交互式会话 TUI — 只做组件编排。
 * 文本宽度/折行/断点/限制在 text/ 与 layout/；各输出块在 render/。
 */
import React, { useSyncExternalStore } from 'react';
import { appendFileSync } from 'node:fs';
import { Box, Static, Text, useCursor, useInput, usePaste } from 'ink';
import { TuiStore, type LogItem } from './store.js';
import { colors } from './theme.js';
import { getBreakpoint } from './layout/breakpoints.js';
import { queueRows, computeInputGeometry, ABOVE_BLOCK_HEIGHTS } from './layout/geometry.js';
import { hintText, inputLines, QUEUE_VISIBLE_ITEMS } from './layout/limits.js';
import { useTerminalSize } from './layout/window-size.js';
import { cursorLineColumn, wrapLines } from './text/wrap.js';
import { contentWidth as contentWidthOf, truncateToWidth } from './text/width.js';
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

/**
 * 用户消息。
 *
 * 必须自己按 `columns - 2` 折行，不能把宽度交给 Yoga：
 * 日志列表跑在 `<Static>` 里，而 Static 的容器是 `position: absolute` 且没有
 * width，Yoga 会按内容撑开它 —— 于是 `flexGrow={1}` 的子项拿到的是「终端宽度」
 * 而不是「终端宽度 - 前缀 2 列」，结果每行都宽出 2 列（80 列终端渲染成 82 列），
 * 终端再折一次就变成用户看到的「屏幕没满就断」。
 *
 * 前缀写进同一个 `<Text>` 而不是并列的兄弟节点，有两个作用：
 *   1. Ink 折行时会把它算进总宽，不会溢出（项目里 ThoughtBlock/SystemLine 同范式）
 *   2. 续行用 `'  '` 前缀自然对齐，无需依赖 Box 左边界
 */
function UserLine({ item }: { item: LogItem }) {
  const { columns } = useTerminalSize();
  const contentWidth = contentWidthOf(columns, 2);
  const lines = wrapLines(item.text, contentWidth);

  return (
    <Box marginTop={1} flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} bold color={colors.text}>
          <Text color={colors.gray}>{i === 0 ? '> ' : '  '}</Text>
          {line || ' '}
        </Text>
      ))}
    </Box>
  );
}

function LogLine({ item }: { item: LogItem }) {
  switch (item.kind) {
    case 'welcome':
      return <WelcomeItem item={item} />;

    case 'user':
      return <UserLine item={item} />;

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

function InputBox(
  { value, cursor, running, queued, aboveRows }: {
    value: string;
    cursor: number;
    running: boolean;
    queued: number;
    /**
     * 动态区域里本组件**上方**占用的行数（状态行等）。
     *
     * ⚠️ 必须与真实渲染条件同源。之前这里没有这个参数、`inputY` 硬编码 2，
     * 于是 busy 时多出来的 ThinkingStatus（2 行）没被算进去，光标偏上 2 行 ——
     * 表现为「发完消息再打字，光标不在输入框里」。
     * 改前发现不了是因为 busy 时输入框整个不渲染，错误值从未被使用。
     */
    aboveRows: number;
  },
) {
  const { columns, rows } = useTerminalSize();
  const bp = getBreakpoint(columns, rows);
  const geometry = computeInputGeometry(columns, bp, aboveRows);
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

  // 边框颜色固定：运行中**依然完全可用**（能打字、能提交、能入队），变灰等于告诉用户
  // 「这里现在没用」，与事实相反。而「提交会入队」已有更好的载体 ——
  // 空态提示文案 + 提交后立刻出现的队列托盘。颜色是多余的重复信号。
  const borderColor = colors.accent;
  const emptyHint = running
    ? truncateToWidth('运行中，输入会在本轮结束后接着发送', geometry.textWidth)
    : truncateToWidth('Try “解释这个仓库的结构”', geometry.textWidth);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        borderStyle="round"
        borderColor={borderColor}
        paddingX={geometry.paddingX}
        width="100%"
      >
        <Box width={geometry.promptWidth} flexShrink={0}>
          <Text color={borderColor} bold>{PROMPT}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {value.length === 0
            ? (
              <Text color={colors.gray} wrap="truncate-end">
                {emptyHint}
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
        <Text color={colors.gray}>{hintText(bp, { running, queued })}</Text>
        {!bp.narrow && <Text color={colors.gray}>Ctrl+C 退出</Text>}
      </Box>
    </Box>
  );
}

// ============================================================
// 队列托盘
// ============================================================
/**
 * 待发送指令的托盘 —— 渲染在输入框**下方**，不是上方。
 *
 * 放上方会让输入框整体下移，`InputBox` 的 `setCursorPosition` 就必须加偏移，
 * 而 `computeInputGeometry.inputY` 是布局数学的单一来源，为一个可选区块改它不值得。
 * 放下方只是末尾多几行，光标位置完全不变 —— 零布局风险。
 *
 * 宽度按 L23/L24 的结论自己算（`contentWidth`），不交给 Yoga；
 * 行内用 `truncateToWidth` 兜底，保证任何终端宽度都不溢出。
 */
function QueueTray({ queue }: { queue: string[] }) {
  const { columns } = useTerminalSize();
  if (queue.length === 0) return null;

  // ⚠️ 必须和工具预览视觉区分开：
  //   工具预览 = `⏺ Bash(args)`（accent 色 + 粗体名字），属于「已经发生过的事」；
  //   队列     = 「已提交、还没开始执行的事」，跟它长得像会让人误以为在跑。
  //   于是刻意用了三处不同：
  //     1. 前缀 `·` 而不是 `⏺`（一个是"待办点"，一个是"已发生的记录"）
  //     2. magenta 而不是 accent（cyan）
  //     3. 带「待发送」标题 —— 无色终端下也能看懂，不依赖颜色
  const PREFIX = '  · ';
  const width = contentWidthOf(columns, 9);   // 留 9 列给前缀
  const shown = queue.slice(0, QUEUE_VISIBLE_ITEMS);
  const rest = queue.length - shown.length;

  return (
    <Box flexDirection="column">
      <Text color={colors.magenta}>
        {`  待发送 ${queue.length} 条`}
      </Text>
      {shown.map((text, i) => (
        <Text key={i} color={colors.magenta} wrap="truncate-end">
          {PREFIX}{i + 1}. {truncateToWidth(text, width)}
        </Text>
      ))}
      {rest > 0 && (
        <Text color={colors.magenta}>{`  … 还有 ${rest} 条`}</Text>
      )}
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

    // ---- 中断 / 退出 的分流 ----
    // 关键：Ctrl+C 在「有活干」和「空闲」时语义完全不同。
    //   运行中（waiting=false）→ 打断当前行动，会话保留
    //   空闲时（waiting=true） → 退出程序（保持原有肌肉记忆）
    // Esc 只做中断；空闲时按 Esc 无副作用（避免误退出）。
    if (key.escape) {
      store.requestInterrupt();
      return;
    }
    if (key.ctrl && (input === 'c' || input === 'd')) {
      // Ctrl+C 先尝试中断；没有可打断的目标才退出
      if (input === 'c' && store.requestInterrupt()) return;
      store.forceExit();
      return;
    }
    // Ctrl+X：只清队列，不打断当前轮。没有它就只能在「中断再重来」之间二选一。
    if (key.ctrl && input === 'x') {
      const n = store.clearQueue();
      if (n > 0) store.append('system', `✕ 已清空队列（${n} 条，按 ↑ 可找回）`);
      return;
    }

    // ⚠️ 这里**不能**再拦 `if (!state.waiting) return`。
    // 运行中也要能打字：Enter 入队，由 store.readLine() 在当前轮结束后取走。
    // 曾经这行是「输入框整个消失」的根源（见 Plan/20261114-1134-tui-command-queue）。

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

  // 粘贴整段文本（含换行），避免被拆成回车提前提交。
  // 运行中同样允许粘贴（入队），否则「先写好三条指令再贴进来」这个用法就没了。
  usePaste((text) => {
    debugInput('paste', text, state.input.length);
    store.insert(text);
  }, { isActive: true });

  // 「InputBox 上方有哪些区块」只在这一处判断，同时喂给渲染条件和高度计算。
  // 分成两处判断就会漂移：渲染了状态行但没算高度 → 光标偏上 2 行。
  // 状态行可见性 = 观察者采到了非 idle 快照。
  // 注意与 state.busy 解耦：busy 是「主循环在跑」，status 是「观察者看见 agent 在做什么」，
  // 后者是渲染层自己的判断，不该被 busy 的单点真值绑定。
  const statusVisible = state.status != null;
  // InputBox 上方的区块：状态行 + 队列托盘。
  // queueRows() 同时决定「托盘渲不渲染」和「占几行」——单点来源，避免漂移（L26）。
  const aboveRows = (statusVisible ? ABOVE_BLOCK_HEIGHTS.status : 0) + queueRows(state.queue.length);

  return (
    <Box flexDirection="column">
      <Static items={state.log}>
        {(item: LogItem) => (
          <ErrorBoundary key={item.id} label={item.kind}>
            <LogLine item={item} />
          </ErrorBoundary>
        )}
      </Static>

      {statusVisible && (
        <ErrorBoundary label="status">
          <ThinkingStatus status={state.status!} />
        </ErrorBoundary>
      )}

      {/* 队列托盘放在输入框**上方**：阅读顺序 = 时间顺序。
          队列里的消息「已提交、即将执行」，逻辑上先于正在输入的内容；
          放下方等于把时间线倒过来。同时与状态行形成自然的层次：
            状态行（agent 在做什么）→ 托盘（接下来做什么）→ 输入框（我正在做什么）。
          ⚠️ 托盘占的行数已计入 aboveRows，否则光标会偏上（见 geometry.queueRows）。 */}
      {queueRows(state.queue.length) > 0 && (
        <ErrorBoundary label="queue">
          <QueueTray queue={state.queue} />
        </ErrorBoundary>
      )}

      {/* 输入框常驻：运行中也显示，因为此刻用户恰好最有空敲下一条指令。
          改前是 `{state.waiting && <InputBox/>}` —— 一轮开始输入框整个消失，
          用户想补充一句只能干等几十秒（见 Plan/20261114-1134-tui-command-queue）。 */}
      <ErrorBoundary label="input">
        <InputBox
          value={state.input}
          cursor={state.cursor}
          running={state.busy}
          queued={state.queue.length}
          aboveRows={aboveRows}
        />
      </ErrorBoundary>
    </Box>
  );
}
