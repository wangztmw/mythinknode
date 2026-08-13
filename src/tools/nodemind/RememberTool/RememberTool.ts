/**
 * Remember — 轻量便签工具。不直接创建节点，只注入标签到消息流。
 * Session 结束后 Reflector 统一消费所有标签 + 完整上下文，创建经验节点。
 */
import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  action: z.enum(['tag']).describe('Tag a discovery for later reflection'),
  title: z.string().describe('What was discovered — a short label'),
  note: z.string().describe('Key points to remember. What worked? What failed? What tool/command was used? What was the result? Be specific — include errors, versions, commands. This will be reviewed by Reflector.'),
  keywords: z.array(z.string()).optional().describe('Related keywords (domains, tools, technologies)'),
  fields: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('Optional structured data (code, config, error codes)'),
});

// ---- pending notes 队列（模块级，session_loop 消费） ----

interface PendingNote {
  title: string;
  note: string;
  keywords: string[];
  fields: Record<string, string | number>;
  timestamp: string;
}

const _pendingNotes: PendingNote[] = [];

/** session_loop 调用：取出所有待处理标签并清空 */
export function flushPendingNotes(): PendingNote[] {
  const notes = [..._pendingNotes];
  _pendingNotes.length = 0;
  return notes;
}

/** 格式化标签为 [REMEMBER_TAG] 消息 */
export function formatPendingNotes(notes: PendingNote[]): string {
  if (notes.length === 0) return '';
  return notes.map((n, i) =>
    `[REMEMBER_TAG ${i + 1}/${notes.length}]
Title: ${n.title}
Keywords: ${n.keywords.join(', ') || '(none)'}
Key points:
${n.note}
${Object.keys(n.fields).length > 0 ? 'Data:\n' + Object.entries(n.fields).map(([k, v]) => `  ${k}: ${v}`).join('\n') : ''}`
  ).join('\n\n---\n\n');
}

// ---- 工具 ----

export const RememberTool = buildTool({
  name: 'Remember',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  async call(input: z.infer<typeof inputSchema>, ctx: ToolUseContext): Promise<ToolResult<string>> {
    if (input.action !== 'tag') return { data: 'Error: only "tag" action.' };
    if (!input.title || !input.note) {
      return { data: 'Error: title and note required.' };
    }

    _pendingNotes.push({
      title: input.title,
      note: input.note,
      keywords: input.keywords || [],
      fields: input.fields || {},
      timestamp: new Date().toISOString(),
    });

    return { data: `Tagged: "${input.title}". Reflector will review and integrate into the experience tree after this session.` };
  },

  async prompt() { return `## Remember\n${DESCRIPTION}\nInput: { action: 'tag', title, note, keywords?, fields? }`; },
  userFacingName: () => 'Remember',
  getToolUseSummary(input: Partial<z.infer<typeof inputSchema>>) {
    return input.title ? `Remember: ${input.title.slice(0, 40)}` : 'Remember';
  },
});
