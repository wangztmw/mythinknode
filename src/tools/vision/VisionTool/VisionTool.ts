import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';
import { scheduleVisionStop, analyzeImage, taskPrompt } from '../vision.js';

const inputSchema = z.object({
  image_path: z.string().describe('Absolute path to the image file'),
  task: z.enum(['latex', 'markdown', 'describe']).optional()
    .describe('Task: latex=公式转LaTeX, markdown=文档转Markdown, describe=描述图片. Default: latex'),
  custom_prompt: z.string().optional().describe('自定义任务说明（覆盖 task）'),
});

export const VisionTool = buildTool({
  name: 'Vision',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => true,
  isConcurrencySafe: () => false,   // 单实例服务 + 用完即停，禁止并发调用

  async call(input: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    try {
      // 通路与本地服务的启停都由 analyzeImage 决定（默认云端优先，失败才拉起本地兜底）
      const prompt = input.custom_prompt || taskPrompt(input.task || 'latex');
      const r = await analyzeImage(input.image_path, prompt);
      const usage = r.inputTokens != null ? ` (in: ${r.inputTokens}, out: ${r.outputTokens ?? 0})` : '';
      return { data: r.text + usage };
    } catch (e) {
      return { data: `Vision error: ${(e as Error).message}` };
    } finally {
      // 本地服务（若被拉起）用完不立即停：重置 3 分钟 idle 倒计时；云端通路下为空操作
      scheduleVisionStop();
    }
  },

  async prompt() { return `## Vision\n${DESCRIPTION}\nInput: { image_path, task?, custom_prompt? }`; },
  userFacingName: () => 'Vision',
  getToolUseSummary(input: Partial<z.infer<typeof inputSchema>>) {
    const fn = input.image_path?.split('/').pop() || input.image_path;
    const t = input.task || 'latex';
    return fn ? `Vision[${t}]: ${fn}` : `Vision[${t}]`;
  },
});
