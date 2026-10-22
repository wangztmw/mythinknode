#!/usr/bin/env node
/**
 * Mythinknode TUI 入口 — 独立运行的只读仪表盘。
 *
 * 用法：
 *   npm run tui
 *   npx tsx src/cli/tui/index.tsx
 *   MYTHINKNODE_LOCAL=1 npm run tui   # 展示本地推理模式
 *
 * 不影响主程序（Mythinknode.ts）的任何行为。
 */
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

const ENTER_ALT_SCREEN = '\u001B[?1049h\u001B[H';
const EXIT_ALT_SCREEN = '\u001B[?1049l';

const isTTY = Boolean(process.stdout.isTTY);
let restored = false;

function restoreScreen(): void {
  if (restored) return;
  restored = true;
  if (isTTY) process.stdout.write(EXIT_ALT_SCREEN);
}

if (isTTY) process.stdout.write(ENTER_ALT_SCREEN);
process.on('exit', restoreScreen);
process.on('SIGINT', () => { restoreScreen(); process.exit(0); });
process.on('SIGTERM', () => { restoreScreen(); process.exit(0); });

const instance = render(<App />, { exitOnCtrlC: true });

await instance.waitUntilExit();
restoreScreen();
