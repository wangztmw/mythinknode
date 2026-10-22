/**
 * 工具调用与结果 — 按当前宽度截断/折叠。
 * 生产端提供 preview 文本 + totalLines/shownLines 元数据。
 */
import React from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { colors } from '../theme.js';
import { getBreakpoint } from '../layout/breakpoints.js';
import { toolVisibleLines } from '../layout/limits.js';
import { wrapLines } from '../text/wrap.js';
import { displayWidth, truncateToWidth } from '../text/width.js';
import type { LogItem } from '../store.js';

export function ToolLine({ item }: { item: LogItem }) {
  const { columns } = useWindowSize();
  const name = String(item.meta?.name ?? item.text);
  const args = String(item.meta?.args ?? '');
  const budget = Math.max(4, columns - displayWidth(name) - 6);
  const shownArgs = truncateToWidth(args, budget);

  return (
    <Box marginTop={1}>
      <Text color={colors.accent}>⏺ </Text>
      <Text bold color={colors.text}>{name}</Text>
      <Text color={colors.gray}>{shownArgs ? `(${shownArgs})` : ''}</Text>
    </Box>
  );
}

export function ToolResult({ item }: { item: LogItem }) {
  const { columns, rows } = useWindowSize();
  const bp = getBreakpoint(columns, rows);
  const maxVisible = toolVisibleLines(bp);
  const contentWidth = Math.max(10, columns - 5);

  const lines = wrapLines(item.text, contentWidth);
  const visible = lines.slice(0, maxVisible);
  const folded = lines.length - visible.length;

  const totalLines = typeof item.meta?.totalLines === 'number'
    ? item.meta.totalLines
    : item.text.split('\n').length;
  const shownLines = typeof item.meta?.shownLines === 'number'
    ? item.meta.shownLines
    : item.text.split('\n').length;
  const unloaded = Math.max(0, totalLines - shownLines);

  return (
    <>
      {visible.map((line, i) => (
        <Box key={i}>
          <Text color={colors.gray}>{i === 0 ? '  ⎿  ' : '     '}</Text>
          <Text color={colors.gray} wrap="truncate-end">{truncateToWidth(line, contentWidth)}</Text>
        </Box>
      ))}
      {(folded > 0 || unloaded > 0) && (
        <Text color={colors.gray}>
          {'     '}… {folded > 0 ? `折叠 ${folded} 行` : ''}
          {folded > 0 && unloaded > 0 ? '，' : ''}
          {unloaded > 0 ? `另有 ${unloaded} 行未预览` : ''}
        </Text>
      )}
    </>
  );
}
