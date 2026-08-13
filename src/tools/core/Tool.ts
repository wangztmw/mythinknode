/**
 * tools — Clean Tool interface
 *
 * 按 Claude Code 原始架构重写，零断裂依赖。
 */

import type { z } from 'zod/v4';

// ============================================================
// ToolResult
// ============================================================
export type ToolResult<T = unknown> = {
  data: T;
  newMessages?: Array<{ role: string; content: unknown }>;
};

// ============================================================
// ToolPermissionContext
// ============================================================
export type ToolPermissionContext = {
  mode: 'default' | 'acceptEdits' | 'plan' | 'bypass';
};

// ============================================================
// ToolEngine — 工具需要的引擎接口（不 import AgentEngine，避免循环依赖）
// ============================================================
export interface ToolEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  team: Map<string, any>;
  createAgentMember(subject: string, desc?: string): { id: string; status: string; subject: string; startTime: number };
  createBashMember(subject: string, desc?: string): { id: string; status: string; subject: string; startTime: number };
  completeMember(id: string, output: string): void;
  onNotify?: (msg: string) => void;
}

// ============================================================
// ToolUseContext — 最小上下文
// ============================================================
export type ToolUseContext = {
  options: {
    tools: Tools;
    verbose: boolean;
    isNonInteractiveSession: boolean;
    mainLoopModel: string;
    debug: boolean;
  };
  abortController: AbortController;
  engine?: ToolEngine;
};

// ============================================================
// PermissionResult
// ============================================================
export type PermissionResult = {
  behavior: 'allow' | 'deny' | 'ask';
  updatedInput?: Record<string, unknown>;
  message?: string;
};

// ============================================================
// Tool interface
// ============================================================
export type Tool<
  Input extends z.ZodType<Record<string, unknown>> = z.ZodType<Record<string, unknown>>,
  Output = unknown,
> = {
  readonly name: string;
  readonly inputSchema: Input;
  readonly description: () => Promise<string>;
  call(args: z.infer<Input>, context: ToolUseContext): Promise<ToolResult<Output>>;
  isReadOnly(args: z.infer<Input>): boolean;
  isEnabled(): boolean;
  checkPermissions(args: z.infer<Input>, context: ToolUseContext): Promise<PermissionResult>;
  prompt(options: { getToolPermissionContext(): Promise<ToolPermissionContext>; tools: Tools }): Promise<string>;
  userFacingName(args: Partial<z.infer<Input>> | undefined): string;
  isConcurrencySafe?(args: z.infer<Input>): boolean;
  isDestructive?(args: z.infer<Input>): boolean;
  getToolUseSummary?(args: Partial<z.infer<Input>> | undefined): string | null;
};

// ============================================================
// ToolDef — partial definition accepted by buildTool
// ============================================================
export type ToolDef<
  Input extends z.ZodType<Record<string, unknown>> = z.ZodType<Record<string, unknown>>,
  Output = unknown,
> = Partial<Tool<Input, Output>> &
  Required<Pick<Tool<Input, Output>, 'name' | 'inputSchema' | 'call' | 'description'>>;

// ============================================================
// Tools collection
// ============================================================
export type Tools = readonly Tool[];

// ============================================================
// buildTool factory
// ============================================================
export function buildTool<Input extends z.ZodType<Record<string, unknown>>, Output = unknown>(
  def: ToolDef<Input, Output>,
): Tool<Input, Output> {
  return {
    isReadOnly: () => false,
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    checkPermissions: async () => ({ behavior: 'allow' }),
    prompt: async () => def.name,
    userFacingName: () => def.name,
    ...def,
  };
}
