/**
 * 状态行 —— 时间由**渲染层自己算**，不是 agent 报给我们的数字。
 *
 * ★ 为什么组件里有 setInterval：
 *   这不是「agent 每秒播报」，而是**观察者**为了让秒数在屏幕上走字而自带的重绘节奏。
 *   agent 只告诉过一次 `startedAt`，之后什么都不知道。
 *   好处：agent 卡住时秒数照涨 → 「数字不走了」这个假象消失，卡顿变成可见的。
 *
 * 见 Plan/20261114-1518-observer-pull-model/ 与 lessons/L26。
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from '../layout/window-size.js';
import { colors } from '../theme.js';
import { contentWidth as contentWidthOf, truncateToWidth } from '../text/width.js';
import type { LogItem } from '../store.js';

const FRAMES = ['✻', '✶', '✳', '✢', '·'];

/**
 * 观察者侧的提示阈值 —— agent 完全不知道这些数字存在。
 *
 * ⚠️ STUCK_HINT 必须**明显小于** query_loop 的 TOOL_TIMEOUT_MS(30s)：
 *    否则工具已被外层护栏放弃、提示却还没出现，用户永远看不到。
 *    15s 是「足够久，肯定不正常」与「早于护栏，来得及提示」的折中。
 */
const SLOW_HINT_MS = 3_000;
const STUCK_HINT_MS = 15_000;

export interface StatusView {
  /** 主文案：'Thinking' 或工具名 */
  main: string;
  /** 阶段说明：'analyzing' / 'reviewing results' / '' */
  detail: string;
  /** 本阶段开始时刻 —— 唯一时间源 */
  startedAt: number;
  /** 上次状态**变化**的时刻（用于判断是不是卡住了） */
  lastChangeAt: number;
}

/** 把 StatusView 渲染成一行文字（纯函数，便于测试） */
export function formatStatus(view: StatusView, now: number): { text: string; warning: string | null } {
  const elapsedMs = Math.max(0, now - view.startedAt);
  const sec = (elapsedMs / 1000).toFixed(1);
  // 两种阶段统一格式：`Bash (1.2s)` / `Thinking (1.2s) · analyzing`
  const head = view.detail ? `${view.main} (${sec}s) · ${view.detail}` : `${view.main} (${sec}s)`;

  const sinceChange = Math.max(0, now - view.lastChangeAt);
  let warning: string | null = null;
  if (sinceChange >= STUCK_HINT_MS) warning = `⚠ ${Math.round(sinceChange / 1000)}s 无变化，可能卡住`;
  else if (elapsedMs >= SLOW_HINT_MS) warning = '仍在进行…';

  return { text: warning ? `${head}  ${warning}` : head, warning };
}

export function ThinkingStatus({ status }: { status: StatusView }) {
  const { columns } = useTerminalSize();
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // 观察者自己的刷新节奏：让秒数走字 + spinner 转。
    // 与 agent 无关 —— agent 早已不再 emit tick（见 agent/progress.ts）。
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % FRAMES.length);
      setNow(Date.now());
    }, 140);
    return () => clearInterval(timer);
  }, []);

  // ⚠️ 必须恒为 1 行：这个组件在 InputBox 上方，高度被
  // ABOVE_BLOCK_HEIGHTS.status 硬编码为 2（marginTop + 1 行）。
  // 若状态文本里混入换行（异常/多行 label），Text 会折成多行 →
  // 多出来的行没被算进光标定位 → 光标偏上。所以换行先压成空格。
  const { text, warning } = formatStatus(status, now);
  const flat = text.replace(/[\r\n]+/g, ' ');

  return (
    <Box marginTop={1}>
      <Text color={colors.brand}>{FRAMES[frame]}</Text>
      <Text bold color={warning ? colors.warn : colors.text}>
        {' '}{truncateToWidth(flat, contentWidthOf(columns, 4))}
      </Text>
    </Box>
  );
}

function metaNumber(meta: LogItem['meta'], key: string): number | null {
  const value = meta?.[key];
  return typeof value === 'number' ? value : null;
}

export function SystemLine({ item }: { item: LogItem }) {
  const { columns } = useTerminalSize();
  const ms = metaNumber(item.meta, 'ms');
  const input = metaNumber(item.meta, 'in');
  const output = metaNumber(item.meta, 'out');

  // 旧事件没有 meta：直接显示文本
  if (ms == null) {
    return <Text color={colors.gray}>{'  '}{item.text}</Text>;
  }

  const time = `${(ms / 1000).toFixed(1)}s`;
  const tokens = input != null && columns >= 70
    ? ` · in ${input} · out ${output ?? 0}`
    : '';
  return <Text color={colors.gray}>{'  '}{time}{tokens}</Text>;
}
