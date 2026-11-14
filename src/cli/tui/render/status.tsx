/**
 * 状态行 —— 时间由**渲染层自己算**，不是 agent 报给我们的数字。
 *
 * ★ 为什么组件里有 setInterval：
 *   这不是「agent 每秒播报」，而是**观察者**为了让秒数在屏幕上走字而自带的重绘节奏。
 *   agent 只告诉过一次 `startedAt`，之后什么都不知道。
 *   好处：agent 卡住时秒数照涨 → 「数字不走了」这个假象消失。
 *
 * ★ 为什么是 1000ms 而不是 140ms：
 *   1) 秒数用 1 秒精度足够（0.1 秒精度对「思考中」没有意义，只会让每帧文本都变，
 *      增量渲染无法跳过任何行）
 *   2) Node 对 TTY 的 stdout 是**同步写**，终端消费慢时 write 会阻塞事件循环 →
 *      stdin 按键排队 → 体感「打字要打两次才显示」。帧率降到 1fps 后写入量降约 7 倍。
 *   3) spinner 的作用是「心跳」而非「流畅动画」——每秒换一个符号已足以表达「还活着」。
 *
 * 见 Plan/20261114-1636-tui-ux-polish/ 与 lessons/L28。
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from '../layout/window-size.js';
import { colors } from '../theme.js';
import { contentWidth as contentWidthOf, truncateToWidth } from '../text/width.js';
import type { LogItem } from '../store.js';

const FRAMES = ['✻', '✶', '✳', '✢', '·'];

/**
 * 重绘周期 = 100ms，与秒数的 0.1 显示精度对齐。
 *
 * 曾经想降到 1000ms 来减少写入量（担心慢终端上同步写阻塞事件循环），
 * 但实测 7fps 与 1fps 的按键延迟都是 9~16ms，没有可测量的差异，
 * 而 1fps 让数字跳得发钝、观感更差。所以按用户要的 0.1 秒节奏来。
 *
 * 真正的优化是「文本没变就不写」—— 由 ink 的增量渲染负责（逐行 diff，
 * 相同的行直接跳过）。0.1 秒粒度下只有状态行这一行在变，成本可控。
 */
const TICK_MS = 100;

export interface StatusView {
  /** 主文案：'Thinking' 或工具名 */
  main: string;
  /** 阶段说明：'analyzing' / 'reviewing results' / '' */
  detail: string;
  /** 本阶段开始时刻 —— 唯一时间源 */
  startedAt: number;
}

/**
 * 把 StatusView 渲染成一行文字（纯函数，便于测试）。
 *
 * ⚠️ 刻意**不做**「可能卡住 / 仍在进行」这类判断：
 *    状态不变既可能是 sleep 30（正常），也可能是真的死锁，这个信号没有区分力。
 *    秒数本身（`Bash (29.0s)`）已经把「过了多久」说清楚了。
 */
export function formatStatus(view: StatusView, now: number): string {
  const elapsedMs = Math.max(0, now - view.startedAt);
  const sec = (elapsedMs / 1000).toFixed(1);
  // 两种阶段统一格式：`Bash (1.2s)` / `Thinking (1.2s) · analyzing`
  return view.detail ? `${view.main} (${sec}s) · ${view.detail}` : `${view.main} (${sec}s)`;
}

export function ThinkingStatus({ status }: { status: StatusView }) {
  const { columns } = useTerminalSize();
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // 观察者自己的刷新节奏：让秒数走字 + spinner 转。与 agent 无关。
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % FRAMES.length);
      setNow(Date.now());
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // ⚠️ 必须恒为 1 行：这个组件在 InputBox 上方，高度被
  // ABOVE_BLOCK_HEIGHTS.status 硬编码为 2（marginTop + 1 行）。
  // 若状态文本里混入换行（异常/多行 label），Text 会折成多行 →
  // 多出来的行没被算进光标定位 → 光标偏上。所以换行先压成空格。
  const text = formatStatus(status, now);
  const flat = text.replace(/[\r\n]+/g, ' ');

  return (
    <Box marginTop={1}>
      <Text color={colors.brand}>{FRAMES[frame]}</Text>
      <Text bold color={colors.text}>
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
