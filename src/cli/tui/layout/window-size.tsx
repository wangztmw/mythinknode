/**
 * 终端尺寸：根部订阅一次，组件走 context。
 *
 * 为什么需要这一层：ink 的 `useWindowSize()` 是「每个组件实例各挂一个 stdout
 * 的 resize 监听器」。本项目有 16 处调用，而 `<Static>` 每次批量追加日志会把
 * 新到达的项同帧全部挂载 —— 一次推入 11 条以上历史，瞬时监听器数就超过 Node
 * 默认 maxListeners(10)，打出：
 *
 *   MaxListenersExceededWarning: 11 resize listeners added to [WriteStream]
 *
 * 那不是真泄漏（下一帧这些组件就卸载、监听器被移除），但会误导用户，并且
 * 用 setMaxListeners(Infinity) 消音会让将来真正的泄漏也静默。所以正确做法是
 * 把订阅收敛到一个 Provider，组件只读 context。
 *
 * ⚠️ 不要在别处再直接调 ink 的 useWindowSize()。`test-tui-window-size.mjs`
 * 有结构断言守着这一条。
 */
import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useWindowSize } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * Provider 之外的兜底值。
 *
 * 不能用 `useWindowSize()` 兜底：`useTerminalSize()` 会变成条件调用 hook
 * （`ctx ?? useWindowSize()`），违反 React 的 hook 调用顺序规则。
 * 静态快照对本项目够用 —— 只有 `renderToString` 渲染单个组件这类场景走这里，
 * 且 `<Static>` 里的历史输出本来就不随 resize 重排。
 */
const FALLBACK: TerminalSize = {
  columns: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
};

const WindowSizeContext = createContext<TerminalSize>(FALLBACK);

/**
 * 必须包在 `render()` 的根位置，不能包在 App 内部 ——
 * 否则 App 自己就在 provider 之外，拿不到真实尺寸。
 */
export function WindowSizeProvider({ children }: { children: ReactNode }) {
  const { columns, rows } = useWindowSize();
  // 只在两个原始值变化时换新对象，避免每次渲染都让所有消费者重渲染
  const value = useMemo<TerminalSize>(() => ({ columns, rows }), [columns, rows]);
  return <WindowSizeContext.Provider value={value}>{children}</WindowSizeContext.Provider>;
}

/** 组件侧读取终端尺寸（不订阅，不增加监听器） */
export function useTerminalSize(): TerminalSize {
  return useContext(WindowSizeContext);
}
