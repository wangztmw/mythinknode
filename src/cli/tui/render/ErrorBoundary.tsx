/**
 * 渲染异常兜底 — 分区包裹，避免单个组件抛错拖垮整个 Ink 帧。
 */
import React from 'react';
import { Text } from 'ink';
import { colors } from '../theme.js';

interface Props {
  children: React.ReactNode;
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Text color={colors.error}>
          ✗ 渲染错误{this.props.label ? `（${this.props.label}）` : ''}: {this.state.error.message}
        </Text>
      );
    }
    return this.props.children;
  }
}
