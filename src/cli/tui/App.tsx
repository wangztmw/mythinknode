/**
 * Mythinknode TUI 仪表盘 — 只读展示，不参与主程序运行。
 *
 * 布局随终端宽度自适应：宽屏双栏（CONFIG | SYSTEM），窄屏单栏堆叠。
 * 数据一次性采集；时钟每秒刷新；q / Ctrl+C 退出。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import Spinner from 'ink-spinner';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';
import { collectSnapshot, type Snapshot } from './data.js';
import { colors } from './theme.js';
import { dashboardBreakpoints } from './layout/breakpoints.js';

const ACCENT = colors.accent;
const MUTED = colors.gray;
const OK = 'green';
const WARN = 'yellow';

// ============================================================
// 基础组件
// ============================================================
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={MUTED} paddingX={1} width="100%">
      <Text color={ACCENT} bold>{title}</Text>
      {children}
    </Box>
  );
}

function Row({ label, value, color = colors.text, labelWidth = 12 }: {
  label: string;
  value: string;
  color?: string;
  labelWidth?: number;
}) {
  return (
    <Box>
      <Box width={labelWidth} flexShrink={0}>
        <Text color={MUTED}>{label}</Text>
      </Box>
      <Text color={color} wrap="truncate-end">{value}</Text>
    </Box>
  );
}

// ============================================================
// 区块
// ============================================================
function Header({ snapshot, columns, rows }: { snapshot: Snapshot; columns: number; rows: number }) {
  const { config, system } = snapshot;
  const modeLabel = config.local ? '⌂ LOCAL' : '☁ CLOUD';
  const modeColor = config.local ? WARN : OK;
  const line = '─'.repeat(Math.max(10, columns - 2));

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          <Text color={ACCENT} bold>◉ MYTHINKNODE</Text>
          <Text color={MUTED}>  v{system.version}</Text>
        </Text>
        <Text>
          <Text color={modeColor} bold>{modeLabel}</Text>
          <Text color={MUTED}>  ·  {config.model}</Text>
        </Text>
      </Box>
      <Text color={MUTED}>{line}</Text>
      {dashboardBreakpoints.logo(columns, rows) && (
        <Box justifyContent="center">
          <BigText text="MYTHINKNODE" font="tiny" colors={['cyan', 'magenta']} />
        </Box>
      )}
    </Box>
  );
}

function ConfigPanel({ snapshot }: { snapshot: Snapshot }) {
  const { config } = snapshot;
  return (
    <Panel title="CONFIG">
      <Row label="模式" value={config.local ? '本地推理' : '云端推理'} color={config.local ? WARN : OK} />
      <Row label="Provider" value={config.provider} />
      <Row label="Model" value={config.model} color={ACCENT} />
      <Row label="Base URL" value={config.openaiBase} />
      <Row label="API Key" value={config.maskedKey} color={config.maskedKey === '未设置' ? WARN : 'white'} />
      <Row label="Key 来源" value={config.keySource} />
    </Panel>
  );
}

function SystemPanel({ snapshot }: { snapshot: Snapshot }) {
  const { system } = snapshot;
  const cwd = system.cwd.replace(process.env.HOME ?? '', '~');
  return (
    <Panel title="SYSTEM">
      <Row label="Node" value={system.node} />
      <Row label="OS" value={system.os} />
      <Row label="Arch" value={system.arch} />
      <Row label="PID" value={String(system.pid)} />
      <Row label="Uptime" value={system.uptime} />
      <Row label="Sessions" value={`${system.sessionCount} 个`} />
      <Row label="Memory" value={system.memorySize} />
      <Row label="CWD" value={cwd} color={MUTED} />
    </Panel>
  );
}

function ToolsPanel({ snapshot }: { snapshot: Snapshot }) {
  const { tools, toolError } = snapshot;
  return (
    <Panel title={`TOOLS · ${tools.length} enabled`}>
      {toolError
        ? <Text color="red">加载失败：{toolError}</Text>
        : <Text color="white" wrap="wrap">{tools.join('   ')}</Text>}
    </Panel>
  );
}

function Footer({ columns }: { columns: number }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const time = now.toLocaleTimeString('zh-CN', { hour12: false });
  const line = '─'.repeat(Math.max(10, columns - 2));

  return (
    <Box flexDirection="column">
      <Text color={MUTED}>{line}</Text>
      <Box justifyContent="space-between">
        <Text>
          <Text color={OK}><Spinner type="dots" /></Text>
          <Text color={MUTED}> 实时刷新 1s</Text>
        </Text>
        <Text color={MUTED}>{time}</Text>
        <Text>
          <Text color={ACCENT}>q</Text>
          <Text color={MUTED}> / </Text>
          <Text color={ACCENT}>Ctrl+C</Text>
          <Text color={MUTED}> 退出</Text>
        </Text>
      </Box>
    </Box>
  );
}

// ============================================================
// App
// ============================================================
export function App() {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const snapshot = useMemo(collectSnapshot, []);
  const narrow = !dashboardBreakpoints.twoColumn(columns);

  useInput((input, key) => {
    if (input === 'q' || input === 'Q' || (key.ctrl && input === 'c')) exit();
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Header snapshot={snapshot} columns={columns} rows={rows} />

      <Box flexDirection={narrow ? 'column' : 'row'} marginTop={1}>
        <Box flexGrow={1} flexBasis={0} marginRight={narrow ? 0 : 1}>
          <ConfigPanel snapshot={snapshot} />
        </Box>
        <Box flexGrow={1} flexBasis={0}>
          <SystemPanel snapshot={snapshot} />
        </Box>
      </Box>

      <Box marginTop={1}>
        <ToolsPanel snapshot={snapshot} />
      </Box>

      <Box marginTop={1}>
        <Gradient name="rainbow">
          <Text color={MUTED}>一个探索智能结构与边界的极简 AI coding agent</Text>
        </Gradient>
      </Box>

      <Box marginTop={1}>
        <Footer columns={columns} />
      </Box>
    </Box>
  );
}
