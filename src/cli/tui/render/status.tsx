/**
 * 状态行与系统行 — 宽度感知，单行截断。
 */
import React, { useEffect, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { colors } from '../theme.js';
import { truncateToWidth } from '../text/width.js';
import type { LogItem } from '../store.js';

const FRAMES = ['✻', '✶', '✳', '✢', '·'];

export function ThinkingStatus({ status }: { status: string }) {
  const { columns } = useWindowSize();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 140);
    return () => clearInterval(timer);
  }, []);

  const [main, detail] = status.split(' — ');
  const text = detail ? `${main} · ${detail}` : main;

  return (
    <Box marginTop={1}>
      <Text color={colors.brand}>{FRAMES[frame]}</Text>
      <Text bold color={colors.text}> {truncateToWidth(text, Math.max(10, columns - 4))}</Text>
    </Box>
  );
}

function metaNumber(meta: LogItem['meta'], key: string): number | null {
  const value = meta?.[key];
  return typeof value === 'number' ? value : null;
}

export function SystemLine({ item }: { item: LogItem }) {
  const { columns } = useWindowSize();
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
