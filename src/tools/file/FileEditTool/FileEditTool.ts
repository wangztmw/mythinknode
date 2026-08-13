import { z } from 'zod/v4';
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to edit'),
  old_string: z.string().min(1, 'old_string must not be empty').describe('Text to replace (must match exactly)'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional().describe('Replace all occurrences'),
});

export const FileEditTool = buildTool({
  name: 'Edit',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,

  async call({ file_path, old_string, new_string, replace_all }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    const fp = resolve(file_path);

    // 读文件
    let content: string;
    try { content = readFileSync(fp, 'utf-8'); }
    catch (e) { return { data: `Error reading ${file_path}: ${(e as Error).message}` }; }

    // CRLF → LF 规范化
    const normalized = content.replace(/\r\n/g, '\n');
    const searchStr = old_string.replace(/\r\n/g, '\n');

    // 查找所有匹配
    const positions: number[] = [];
    let idx = 0;
    while ((idx = normalized.indexOf(searchStr, idx)) !== -1) {
      positions.push(idx);
      idx += searchStr.length;
    }

    if (positions.length === 0) {
      return { data: `Error: old_string not found in ${file_path}` };
    }

    if (positions.length > 1 && !replace_all) {
      const lines = normalized.split('\n');
      const details = positions.map(pos => {
        const lineNum = normalized.slice(0, pos).split('\n').length;
        const ctx = lines.slice(Math.max(0, lineNum - 2), lineNum + 2).join('\n');
        return `  Line ${lineNum}:\n${ctx}\n`;
      }).join('\n');
      return {
        data: `Found ${positions.length} matches, but replace_all is false.\nAdd more context to old_string to make it unique, or set replace_all: true.\n\nMatches:\n${details}`,
      };
    }

    // 执行替换
    const result = normalizeLineEndings(
      replace_all ? normalized.split(searchStr).join(new_string) : normalized.slice(0, positions[0]) + new_string + normalized.slice(positions[0] + searchStr.length),
      content
    );

    // 原子写入：先写临时文件，再 rename
    const tmpFile = `${fp}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmpFile, result, 'utf-8');
      renameSync(tmpFile, fp);
    } catch (e) {
      try { unlinkSync(tmpFile); } catch {}
      return { data: `Error writing ${file_path}: ${(e as Error).message}` };
    }

    const count = replace_all ? positions.length : 1;
    return { data: `Edited ${file_path} (${count} replacement${count > 1 ? 's' : ''})` };
  },

  async prompt() { return `## Edit\n${DESCRIPTION}\nInput: { file_path, old_string, new_string, replace_all? }`; },
  userFacingName: () => 'Edit',
  getToolUseSummary({ file_path: fp, old_string: old }: Partial<z.infer<typeof inputSchema>>) {
    return fp ? `Edit: ${fp}${old ? ` "${old.slice(0, 40)}"` : ''}` : null;
  },
});

// 保持原始换行符风格
function normalizeLineEndings(result: string, original: string): string {
  if (original.includes('\r\n') && !result.includes('\r\n')) {
    return result.replace(/\n/g, '\r\n');
  }
  return result;
}
