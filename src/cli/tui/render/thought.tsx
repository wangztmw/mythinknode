/**
 * thought 块 — 生产端给语义上限，这里按当前宽度折叠为可视行。
 */
import React from 'react';
import { Text, useWindowSize } from 'ink';
import { colors } from '../theme.js';
import { THOUGHT_VISIBLE_LINES } from '../layout/limits.js';
import { wrapLines } from '../text/wrap.js';
import { truncateToWidth } from '../text/width.js';
import type { LogItem } from '../store.js';

export function ThoughtBlock({ item }: { item: LogItem }) {
  const { columns } = useWindowSize();
  const contentWidth = Math.max(10, columns - 2);
  const lines = wrapLines(item.text, contentWidth);
  const visible = lines.slice(0, THOUGHT_VISIBLE_LINES);
  const folded = lines.length - visible.length;

  const totalLines = typeof item.meta?.totalLines === 'number' ? item.meta.totalLines : item.text.split('\n').length;
  const shownLines = typeof item.meta?.shownLines === 'number' ? item.meta.shownLines : item.text.split('\n').length;
  const unloaded = Math.max(0, totalLines - shownLines);

  return (
    <>
      {visible.map((line, i) => (
        <Text key={i} color={colors.gray} italic wrap="truncate-end">
          {'  '}{truncateToWidth(line, contentWidth)}
        </Text>
      ))}
      {(folded > 0 || unloaded > 0) && (
        <Text color={colors.gray}>
          {'  '}… {folded > 0 ? `折叠 ${folded} 行` : ''}
          {folded > 0 && unloaded > 0 ? '，' : ''}
          {unloaded > 0 ? `另有 ${unloaded} 行未预览` : ''}
        </Text>
      )}
    </>
  );
}
