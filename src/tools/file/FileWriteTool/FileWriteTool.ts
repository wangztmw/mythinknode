import { z } from 'zod/v4';
import { writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to write'),
  content: z.string().describe('Content to write'),
});

export const FileWriteTool = buildTool({
  name: 'Write',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,

  async call({ file_path, content }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    const fp = resolve(file_path);
    const existed = existsSync(fp);
    const isEmpty = content.length === 0;

    // 空内容警告
    if (isEmpty) {
      return { data: `Warning: writing empty content to ${file_path}. If you meant to clear this file, this is correct. Otherwise, check your content.` };
    }

    // 原子写入：临时文件 + rename
    mkdirSync(dirname(fp), { recursive: true });
    const tmpFile = `${fp}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmpFile, content, 'utf-8');
      renameSync(tmpFile, fp);
    } catch (e) {
      try { unlinkSync(tmpFile); } catch {}
      return { data: `Error writing ${file_path}: ${(e as Error).message}` };
    }

    const tail = content.endsWith('\n') ? '' : ' (no trailing newline)';
    const status = existed ? 'Updated' : 'Created';
    return { data: `${status} ${file_path} (${content.split('\n').length} lines${tail})` };
  },

  isConcurrencySafe: () => false,
  async prompt() { return `## Write\n${DESCRIPTION}\nInput: { file_path, content }`; },
  userFacingName: () => 'Write',
  getToolUseSummary({ file_path: fp }: Partial<z.infer<typeof inputSchema>>) {
    return fp ? `Write: ${fp.split('/').pop() || fp}` : null;
  },
});
