import { z } from 'zod/v4';
import { readFileSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file'),
  offset: z.number().optional().describe('Line number to start from (1-based)'),
  limit: z.number().optional().describe('Max lines to read (default 2000)'),
});

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export const FileReadTool = buildTool({
  name: 'Read',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call({ file_path, offset, limit }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    // 绝对路径验证
    if (!isAbsolute(file_path)) {
      return { data: `Error: file_path must be absolute, got: ${file_path}` };
    }

    const fp = resolve(file_path);

    // 检查文件是否存在 + 大小
    let stats;
    try { stats = statSync(fp); }
    catch { return { data: `Error: file not found: ${file_path}` }; }

    if (stats.isDirectory()) {
      return { data: `Error: ${file_path} is a directory, not a file` };
    }

    if (stats.size > MAX_SIZE_BYTES) {
      return { data: `Error: file too large (${(stats.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_SIZE_BYTES / 1024 / 1024}MB)` };
    }

    // 图片/PDF 检测
    const ext = file_path.split('.').pop()?.toLowerCase() || '';
    if (IMAGE_EXTS.has(ext)) {
      return { data: `[Image: ${file_path} (${(stats.size / 1024).toFixed(1)}KB)]\nUse an image viewer to see this file.` };
    }
    if (ext === 'pdf') {
      return { data: `[PDF: ${file_path} (${(stats.size / 1024).toFixed(1)}KB)]\nUse a PDF reader to view this document.` };
    }
    if (ext === 'ipynb') {
      try {
        const raw = readFileSync(fp, 'utf-8');
        const nb = JSON.parse(raw);
        const cells = (nb.cells || []) as Array<{ cell_type: string; source: string | string[] }>;
        const output = cells.map((c, i) => {
          const src = Array.isArray(c.source) ? c.source.join('') : c.source;
          return `[${c.cell_type} ${i}]\n${src}`;
        }).join('\n\n');
        return { data: output };
      } catch { return { data: `[Jupyter Notebook: ${file_path}]` }; }
    }

    // 读文件 + 二进制检测
    let buffer: Buffer;
    try { buffer = readFileSync(fp); }
    catch (e) { return { data: `Error reading ${file_path}: ${(e as Error).message}` }; }

    // 二进制检测：前 4096 字节有 NUL 或 >30% 不可打印
    const sample = buffer.slice(0, 4096);
    const nulCount = sample.filter(b => b === 0).length;
    const nonPrintable = sample.filter(b => b < 0x09 || (b > 0x0d && b < 0x20)).length;
    if (nulCount > 0 || nonPrintable > sample.length * 0.3) {
      return { data: `[Binary file: ${file_path} (${(stats.size / 1024).toFixed(1)}KB)]` };
    }

    const content = buffer.toString('utf-8');
    const lines = content.split('\n');
    const start = (offset || 1) - 1;
    const end = start + (limit || 2000);
    const selected = lines.slice(start, end);
    const numbered = selected.map((l, i) => `${String(start + i + 1).padStart(6, ' ')}\t${l}`).join('\n');
    const header = !offset && lines.length <= (limit || 2000) ? '' :
      `(lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length})\n`;
    return { data: header + numbered };
  },

  async prompt() { return `## Read\n${DESCRIPTION}\nInput: { file_path, offset?, limit? }`; },
  userFacingName: () => 'Read',
  getToolUseSummary({ file_path: fp }: Partial<z.infer<typeof inputSchema>>) {
    return fp ? `Read: ${fp.split('/').pop() || fp}` : null;
  },
});
