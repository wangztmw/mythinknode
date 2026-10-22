/**
 * 欢迎框 — 响应式：按首帧终端宽度定型（Static 内容不随 resize 重排）。
 */
import React from 'react';
import { Box, Text, renderToString, useWindowSize } from 'ink';
import BigText from 'ink-big-text';
import Gradient from 'ink-gradient';
import { colors } from '../theme.js';
import { clamp } from '../layout/limits.js';
import { welcomeLogo } from '../layout/breakpoints.js';
import { truncateToWidth } from '../text/width.js';
import type { LogItem } from '../store.js';

/** BigText 上下各留 2 行空白，预渲染后裁掉 */
const LOGO = renderToString(
  <BigText text="MYTHINKNODE" font="tiny" colors={['white']} />,
  { columns: 90 },
)
  .replace(/\u001B\[[0-9;]*m/g, '')
  .split('\n')
  .filter(line => line.trim().length > 0)
  .join('\n');

function KeyVal({ k, v, valueWidth }: { k: string; v: string; valueWidth: number }) {
  return (
    <Box>
      <Box width={10} flexShrink={0}><Text color={colors.gray}>{k}</Text></Box>
      <Text color={colors.text} wrap="truncate-end">{truncateToWidth(v, valueWidth)}</Text>
    </Box>
  );
}

export function WelcomeItem({ item }: { item: LogItem }) {
  const { columns } = useWindowSize();
  const meta = item.meta ?? {};
  const boxWidth = clamp(columns - 2, 24, columns);
  const valueWidth = Math.max(8, boxWidth - 14);

  if (columns < 40) {
    return (
      <Text color={colors.brand} wrap="truncate-end">
        ✻ Mythinknode v{String(meta.version ?? '')}
      </Text>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.brand}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
      width={boxWidth}
    >
      <Text>
        <Text color={colors.brand}>✻</Text>
        <Text bold color={colors.text}> Welcome to Mythinknode!</Text>
        {meta.version ? <Text color={colors.gray}>  v{meta.version}</Text> : null}
      </Text>

      {welcomeLogo(columns) && (
        <Box marginTop={1} marginBottom={1}>
          <Gradient colors={[colors.brand, colors.magenta, colors.accent]}>
            <Text>{LOGO}</Text>
          </Gradient>
        </Box>
      )}

      <KeyVal k="model" v={String(meta.model ?? '')} valueWidth={valueWidth} />
      <KeyVal k="provider" v={String(meta.provider ?? '')} valueWidth={valueWidth} />
      <KeyVal k="mode" v={String(meta.mode ?? '')} valueWidth={valueWidth} />
      <KeyVal k="tools" v={String(meta.tools ?? '')} valueWidth={valueWidth} />
      <KeyVal k="cwd" v={String(meta.cwd ?? '')} valueWidth={valueWidth} />
      <KeyVal k="memory" v={String(meta.memory ?? '')} valueWidth={valueWidth} />

      <Box marginTop={1}>
        <Text color={colors.gray} wrap="truncate-end">
          {truncateToWidth('/help 查看命令  ·  /local /cloud 切换模型  ·  Ctrl+C 退出', Math.max(10, boxWidth - 4))}
        </Text>
      </Box>
    </Box>
  );
}
