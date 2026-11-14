/**
 * 会话完整性修复。
 *
 * ## 为什么需要这个模块
 *
 * LLM API 对 tool 消息有**配对强制要求**：
 *
 *   OpenAI:    assistant.tool_calls[i].id 必须都能找到 role:'tool' + tool_call_id 的回复
 *   Anthropic: tool_use 块之后必须跟 tool_result 块
 *
 * 如果在「assistant 已 push 了 tool_use、tool_result 还没 push」的瞬间被打断
 * （用户按 Esc / Ctrl+C、进程被 kill、工具抛异常逃逸），`messages` 就留下
 * **悬空的 tool_use**。下一次请求会 400：
 *
 *   messages with role 'tool' must be a response to a preceding message with 'tool_calls'
 *
 * 而且这个 400 是**永久性**的 —— 每次发消息都失败，`-r` 恢复也救不回来。
 * 整个会话等于报废。
 *
 * 所以中断路径必须修复，而不是仅仅「停下来」。
 */
import type { ChatMessage } from '../llm/types.js';

interface ToolUseBlock { type: 'tool_use'; id?: string; name?: string; input?: unknown }
interface ToolResultBlock { type: 'tool_result'; tool_use_id?: string }

function isToolUse(b: unknown): b is ToolUseBlock {
  return !!b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use';
}

function isAssistantBlocks(m: ChatMessage): m is ChatMessage & { content: Array<unknown> } {
  return m.role === 'assistant' && Array.isArray(m.content);
}

/** 该消息是否是「工具结果载体」—— 满足任一形式即算 */
function isToolResultCarrier(m: ChatMessage): boolean {
  if (m.role === 'tool') return true;
  if (m.role !== 'user' || !Array.isArray(m.content)) return false;
  return (m.content as Array<unknown>).some(b => !!b && typeof b === 'object'
    && (b as { type?: string }).type === 'tool_result');
}

/** 从一条工具结果载体里取出所有 tool_use_id */
function resultIds(m: ChatMessage): string[] {
  if (m.role === 'tool') {
    const id = (m as unknown as { tool_call_id?: string }).tool_call_id;
    return id ? [id] : [];
  }
  const out: string[] = [];
  for (const b of m.content as Array<unknown>) {
    const r = b as ToolResultBlock;
    if (r && typeof r === 'object' && r.type === 'tool_result' && r.tool_use_id) out.push(r.tool_use_id);
  }
  return out;
}

export interface RepairReport {
  /** 补齐了几条 tool_result */
  patched: number;
  /** 被修复的 tool_use id（便于日志/测试） */
  ids: string[];
}

export interface RepairOptions {
  /** 缺失结果的填充文本 */
  content?: string;
  /**
   * 为某次工具调用生成一条「结果载体」消息。
   * 必须由 provider 提供 —— OpenAI 是 `{role:'tool', tool_call_id}`，
   * Anthropic 是 `{role:'user', content:[{type:'tool_result', tool_use_id}]}`。
   */
  formatToolResult: (toolCallId: string, output: string) => ChatMessage;
}

/**
 * 扫描整个 messages，把「有 tool_use 但没有配对 tool_result」的地方补上合成结果。
 *
 * 判定规则：对每条 assistant(tool_use) 消息，向后收集**连续的**工具结果载体，
 * 直到遇到非工具结果消息为止；这个窗口里缺少的 id 就是要补的。
 *
 * 为什么只在「连续窗口」里找：tool_result 必须紧跟在 assistant 之后
 * （中间插 user 文本会让 API 认为 tool 消息孤立）。超出窗口的视为缺失。
 *
 * @returns 就地修改 messages；返回补了几条
 */
export function repairDanglingToolUses(
  messages: ChatMessage[],
  opts: RepairOptions,
): RepairReport {
  const fill = opts.content ?? '[interrupted] 该工具调用因用户中断而未执行完成，没有结果。';
  const report: RepairReport = { patched: 0, ids: [] };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!isAssistantBlocks(m)) continue;

    const uses = (m.content as Array<unknown>).filter(isToolUse)
      .map(b => (b as ToolUseBlock).id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (uses.length === 0) continue;

    // 向后收集连续的工具结果载体
    const seen = new Set<string>();
    let j = i + 1;
    while (j < messages.length && isToolResultCarrier(messages[j])) {
      for (const id of resultIds(messages[j])) seen.add(id);
      j++;
    }

    const missing = uses.filter(id => !seen.has(id));
    if (missing.length === 0) continue;

    // 插入位置：紧跟在已存在的工具结果之后（j 之前），保持顺序稳定
    const synthetic = missing.map(id => opts.formatToolResult(id, fill));
    messages.splice(j, 0, ...synthetic);

    report.patched += synthetic.length;
    report.ids.push(...missing);

    // splice 后长度变了，让循环继续从新增内容之后的第一个位置走
    i = j + synthetic.length - 1;
  }

  return report;
}

/**
 * 中断说明 —— 注入给模型，让它知道上一轮是被打断的，不是它做完了。
 *
 * 为什么需要：不说明的话模型会以为工具返回了 "interrupted" 就代表执行成功，
 * 继续按原计划往下走，第二次请求还可能重复同一个危险操作。
 */
export function interruptNotice(round: number, toolCount: number, reason = '用户中断'): string {
  const parts = [
    `[INTERRUPTED] ${reason}：第 ${round} 轮执行在完成前被用户手动中止。`,
  ];
  if (toolCount > 0) {
    parts.push(`本轮已发起的 ${toolCount} 个工具调用可能只执行了部分，结果被标记为 interrupted。`);
  }
  parts.push('不要假设上一轮已经完成，也不要自动重试同一个危险操作。');
  parts.push('等用户说明下一步该做什么；如果只是继续，先简述你已完成的部分。');
  return parts.join('\n');
}
