/**
 * 状态行与系统行 — 宽度感知，单行截断。
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from '../layout/window-size.js';
import { colors } from '../theme.js';
import { contentWidth as contentWidthOf, truncateToWidth } from '../text/width.js';
import type { LogItem } from '../store.js';

const FRAMES = ['✻', '✶', '✳', '✢', '·'];

export function ThinkingStatus({ status }: { status: string }) {
  const { columns } = useTerminalSize();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 140);
    return () => clearInterval(timer);
  }, []);

  // ⚠️ 必须恒为 1 行：这个组件在 InputBox 上方，高度被
  // ABOVE_BLOCK_HEIGHTS.status 硬编码为 2（marginTop + 1 行）。
  // 若状态文本里混入换行（异常/多行 label），Text 会折成多行 →
  // 多出来的行没被算进光标定位 → 光标偏上。所以换行先压成空格。
  const [main, detail] = status.replace(/[\r\n]+/g, ' ').split(' — ');
  const text = detail ? `${main} · ${detail}` : main;

  return (
    <Box marginTop={1}>
      <Text color={colors.brand}>{FRAMES[frame]}</Text>
      <Text bold color={colors.text}> {truncateToWidth(text, contentWidthOf(columns, 4))}</Text>
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
