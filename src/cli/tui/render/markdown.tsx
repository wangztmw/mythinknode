/**
 * Markdown → Ink —— TUI 独立实现。
 *
 * 段落/列表/引用先合并软换行，再由 Ink 按当前容器宽度折行；
 * 代码块保留原始换行；表格在窄屏降级为 key-value。
 */
import React, { useMemo } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { colors } from '../theme.js';
import { displayWidth, graphemes, truncateToWidth } from '../text/width.js';
import { parseMarkdown, preferredWrapMode, type MdBlock, type MdListItem } from './markdown-parse.js';
import { computeColumnWidths } from './table.js';
import { parseInline, wrapSegments, type InlineSegment } from './inline.js';

function renderInline(segments: InlineSegment[]): React.ReactNode[] {
  return segments.map((segment, i) => {
    if (segment.color) return <Text key={i} color={segment.color}>{segment.text}</Text>;
    if (segment.bold) return <Text key={i} bold color={colors.text}>{segment.text}</Text>;
    if (segment.code) return <Text key={i} color={colors.code}>{segment.text}</Text>;
    if (segment.italic) return <Text key={i} italic color={colors.gray}>{segment.text}</Text>;
    return segment.text;
  });
}

/** 行内片段的可见宽度（不含 ** / ` 等标记） */
function segmentsWidth(segments: InlineSegment[]): number {
  return segments.reduce((sum, segment) => sum + displayWidth(segment.text), 0);
}

/** 按显示宽度截断行内片段：保留样式，不切断 grapheme，末尾补省略号 */
function truncateSegments(segments: InlineSegment[], maxWidth: number): InlineSegment[] {
  if (segmentsWidth(segments) <= maxWidth) return segments;
  if (maxWidth <= 0) return [];

  const budget = Math.max(0, maxWidth - 1); // 省略号占 1 格
  const out: InlineSegment[] = [];
  let used = 0;

  for (const segment of segments) {
    let text = '';
    for (const char of graphemes(segment.text)) {
      const charWidth = displayWidth(char);
      if (used + charWidth > budget) break;
      text += char;
      used += charWidth;
    }
    if (text) out.push({ ...segment, text });
  }

  out.push({ text: '…' });
  return out;
}

/** 表格单元格：渲染行内标记并按列宽补齐空格 */
function renderCell(cell: string, width: number): React.ReactNode {
  const segments = truncateSegments(parseInline(cell), width);
  const pad = ' '.repeat(Math.max(0, width - segmentsWidth(segments)));
  return (
    <>
      {renderInline(segments)}
      {pad}
    </>
  );
}

/**
 * 中文占比高：用自带折行器（避头尾）；英文为主：交给 Ink 按词折行。
 */
function renderTextBlock(
  text: string,
  width: number,
  textProps?: { color?: string; italic?: boolean },
): React.ReactNode {
  const segments = parseInline(text);

  if (preferredWrapMode(text) === 'hard') {
    const lines = wrapSegments(segments, width);
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i} wrap="truncate-end" color={textProps?.color} italic={textProps?.italic}>
            {renderInline(line)}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Text wrap="wrap" color={textProps?.color} italic={textProps?.italic}>
      {renderInline(segments)}
    </Text>
  );
}

function Table({ rows, width }: { rows: string[][]; width: number }) {
  if (rows.length === 0) return null;
  const header = rows[0] ?? [];
  const columnCount = Math.max(...rows.map(row => row.length));
  const separatorWidth = 3 * (columnCount - 1);

  // 窄屏 / 列数太多：降级为逐字段一行，值换行时保持悬挂缩进
  if (width < 56 || columnCount * 5 + separatorWidth > width) {
    const data = rows.slice(1);
    if (data.length === 0) {
      return (
        <Text wrap="wrap">
          {header.map((cell, c) => (
            <React.Fragment key={c}>
              {c > 0 ? ' · ' : ''}
              {renderInline(parseInline(cell))}
            </React.Fragment>
          ))}
        </Text>
      );
    }

    const labelWidth = Math.min(
      Math.max(4, ...header.map(h => segmentsWidth(parseInline(h)) + 1)),
      Math.max(6, Math.floor(width / 3)),
    );

    return (
      <Box flexDirection="column">
        {data.map((row, r) => (
          <Box key={r} flexDirection="column" marginBottom={r < data.length - 1 ? 1 : 0}>
            {row.map((cell, c) => (
              <Box key={c} flexDirection="row">
                <Box width={labelWidth} flexShrink={0}>
                  <Text color={colors.gray}>
                    {renderInline(truncateSegments(parseInline(`${header[c] ?? `col${c + 1}`}:`), labelWidth))}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text wrap={preferredWrapMode(parseInline(cell).map(s => s.text).join(''))}>
                    {renderInline(parseInline(cell))}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    );
  }

  const natural = Array.from({ length: columnCount }, (_, c) =>
    Math.max(4, ...rows.map(row => segmentsWidth(parseInline(row[c] ?? '')))),
  );
  const widths = computeColumnWidths(natural, Math.max(columnCount * 4, width - separatorWidth));

  return (
    <Box flexDirection="column">
      {rows.map((row, r) => (
        <Text key={r} bold={r === 0}>
          {Array.from({ length: columnCount }, (_, c) => (
            <React.Fragment key={c}>
              {renderCell(row[c] ?? '', widths[c])}
              {c < columnCount - 1 ? ' │ ' : ''}
            </React.Fragment>
          ))}
        </Text>
      ))}
    </Box>
  );
}

function ListItem({ item, contentWidth }: { item: MdListItem; contentWidth: number }) {
  const indent = '  '.repeat(item.indent);
  const marker = item.ordered ? `${item.marker} ` : '• ';
  const leftWidth = displayWidth(indent) + displayWidth(marker);
  const rightWidth = Math.max(1, contentWidth - leftWidth);

  return (
    <Box flexDirection="row">
      <Box width={leftWidth} flexShrink={0}>
        <Text>{indent}<Text color={colors.accent}>{marker}</Text></Text>
      </Box>
      <Box flexGrow={1}>
        {renderTextBlock(item.text, rightWidth)}
      </Box>
    </Box>
  );
}

export function MarkdownBlock({ text, columns: columnsProp }: { text: string; columns?: number }) {
  const { columns: terminalColumns } = useWindowSize();
  const columns = columnsProp ?? terminalColumns;
  const contentWidth = Math.max(10, columns - 2);
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  const nodes: React.ReactNode[] = [];
  let first = true;
  let key = 0;

  const prefix = (): string => {
    const value = first ? '⏺ ' : '  ';
    first = false;
    return value;
  };

  const row = (content: React.ReactNode): React.ReactNode => (
    <Box key={key++} flexDirection="row">
      <Text color={colors.accent}>{prefix()}</Text>
      <Box flexGrow={1} flexDirection="column">{content}</Box>
    </Box>
  );

  const renderBlock = (block: MdBlock): React.ReactNode => {
    switch (block.type) {
      case 'paragraph':
        return row(renderTextBlock(block.text, contentWidth));

      case 'heading':
        return row(
          <Text bold wrap={preferredWrapMode(block.text)} color={block.level === 1 ? colors.brand : colors.text}>
            {block.level === 1 ? '▌ ' : ''}{renderInline(parseInline(block.text))}
          </Text>,
        );

      case 'list':
        return row(
          <Box flexDirection="column">
            {block.items.map((item, i) => (
              <ListItem key={i} item={item} contentWidth={contentWidth} />
            ))}
          </Box>,
        );

      case 'quote':
        return row(
          <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text color={colors.gray}>│ </Text>
            </Box>
            <Box flexGrow={1}>
              {renderTextBlock(block.text, Math.max(1, contentWidth - 2), {
                color: colors.gray,
                italic: true,
              })}
            </Box>
          </Box>,
        );

      case 'code':
        return row(
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={colors.gray}
            paddingX={1}
            width="100%"
          >
            {block.lang ? <Text color={colors.gray}>{block.lang}</Text> : null}
            {block.lines.length === 0
              ? <Text color={colors.gray}> </Text>
              : block.lines.map((line, i) => (
                <Text key={i} color={colors.code}>
                  {displayWidth(line) > contentWidth * 4
                    ? truncateToWidth(line, contentWidth)
                    : (line || ' ')}
                </Text>
              ))}
          </Box>,
        );

      case 'table':
        return row(<Table rows={block.rows} width={contentWidth} />);

      case 'rule':
        return row(<Text color={colors.gray}>{'─'.repeat(Math.max(10, contentWidth))}</Text>);
    }
  };

  blocks.forEach((block, index) => {
    if (index > 0) nodes.push(<Text key={key++}> </Text>);
    nodes.push(renderBlock(block));
  });

  return <Box flexDirection="column" marginBottom={1}>{nodes}</Box>;
}
