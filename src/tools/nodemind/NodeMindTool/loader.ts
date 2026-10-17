/**
 * NodeMindTool 动态加载器核心 — 把 nodemind 节点的 attrs 编译成可调用的 Tool。
 *
 * 设计约定：一个节点 = 一个可调用工具；attrs 并存「规范」与「实现」：
 *   - [config] 工具规范（function-calling 声明）:
 *       fields.toolName    → 工具名（注册进 engine.toolMap，须匹配 ^[A-Za-z_][A-Za-z0-9_-]*$）
 *       fields.description → 工具说明（同步字符串，直接发给模型）
 *       fields.parameters  → JSON Schema 字符串（描述输入参数，转成 zod schema）
 *   - [code] 工具实现（可执行 JS 源码）:
 *       fields.source      → `module.exports = async function(input, helpers) { ... }`
 *                            return 字符串 或 { data: ... }（ToolResult）
 *
 * 执行走 Node 内置 vm 沙箱：白名单注入 helpers（vision 调用库 + fetch + zod），
 * 不注入 process/require/fs → 知识树里的代码无法触达文件系统/进程/网络凭据。
 * 改知识树 = 改工具；知识树里的代码即工具实现。
 */
import vm from 'node:vm';
import { z } from 'zod/v4';
import type { AttrNode } from '../../../nodemind/nodeMind_manage.js';
import { buildTool, type Tool } from '../../core/Tool.js';
import { analyzeImage, taskPrompt, ensureVisionServer, stopVisionServer } from '../../vision/vision.js';

// ============================================================
// 沙箱白名单：暴露给 code attr 的能力。
// 默认不含 fs / process / require / child_process → 代码无法触达宿主。
// ============================================================
export const SANDBOX_HELPERS = {
  analyzeImage,
  taskPrompt,
  ensureVisionServer,
  stopVisionServer,
  fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  zod: z,
} as const;

// ============================================================
// JSON Schema → zod（覆盖 function-calling 常用子集）
// ============================================================
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const type = schema.type;
  const desc = schema.description ? String(schema.description) : undefined;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const en = z.enum(schema.enum as [string, ...string[]]);
    return desc ? en.describe(desc) : en;
  }

  if (type === 'object') {
    const props = (schema.properties || {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required as string[]) || []);
    const shape: Record<string, z.ZodType> = {};
    for (const [k, v] of Object.entries(props)) {
      let field = jsonSchemaToZod(v);
      if (!required.has(k)) field = field.optional();
      shape[k] = field;
    }
    return z.object(shape);
  }

  if (type === 'array') {
    const items = (schema.items as Record<string, unknown>) || { type: 'string' };
    const arr = z.array(jsonSchemaToZod(items));
    return desc ? arr.describe(desc) : arr;
  }

  if (type === 'number' || type === 'integer') {
    const n = z.number();
    return desc ? n.describe(desc) : n;
  }

  if (type === 'boolean') {
    const b = z.boolean();
    return desc ? b.describe(desc) : b;
  }

  // string / 未知类型兜底为 string
  const s = z.string();
  return desc ? s.describe(desc) : s;
}

// ============================================================
// 编译 code attr → 可调用实现
// ============================================================
function compileSource(source: string): (input: unknown, helpers: unknown) => Promise<unknown> {
  const sandbox: Record<string, unknown> = {
    module: { exports: undefined },
    helpers: SANDBOX_HELPERS,
  };

  try {
    // timeout 只限制顶层脚本求值时间；返回的 async 函数运行时不受此限制
    vm.runInNewContext(source, sandbox, { timeout: 3000, displayErrors: true });
  } catch (e) {
    throw new Error(`code attr 编译失败: ${(e as Error).message}`);
  }

  const fn = (sandbox.module as { exports?: unknown }).exports;
  if (typeof fn !== 'function') {
    throw new Error('code attr 必须 `module.exports = async function(input, helpers) { ... }`');
  }
  return fn as (input: unknown, helpers: unknown) => Promise<unknown>;
}

// ============================================================
// 主入口：attrs → Tool
// ============================================================
export interface LoadedTool {
  tool: Tool;
  name: string;
}

export function buildToolFromAttrs(attrs: AttrNode[]): LoadedTool {
  const config = attrs.find(a => a.type === 'config' && a.fields && a.fields.toolName);
  const code = attrs.find(a => a.type === 'code' && a.fields && a.fields.source);

  if (!config?.fields) {
    throw new Error('节点缺少 config attr（toolName/description/parameters 工具规范）');
  }
  if (!code?.fields?.source) {
    throw new Error('节点缺少 code attr（source 工具实现）');
  }

  const name = String(config.fields.toolName);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`非法工具名 "${name}"（须匹配 ^[A-Za-z_][A-Za-z0-9_-]*$）`);
  }

  const description = String(config.fields.description || config.content || name);

  let jsonSchema: Record<string, unknown> = { type: 'object', properties: {} };
  const paramsRaw = config.fields.parameters ?? config.fields.schema;
  if (paramsRaw) {
    try {
      jsonSchema = JSON.parse(String(paramsRaw)) as Record<string, unknown>;
    } catch {
      throw new Error(`config attr 的 parameters 不是合法 JSON: ${String(paramsRaw).slice(0, 80)}`);
    }
  }

  const inputSchema = jsonSchemaToZod(jsonSchema) as z.ZodType<Record<string, unknown>>;
  const impl = compileSource(String(code.fields.source));

  const tool = buildTool({
    name,
    inputSchema,
    description, // 纯字符串 → formatTools 能正确序列化发给模型
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    async call(args, _ctx) {
      const out = await impl(args, SANDBOX_HELPERS);
      if (out && typeof out === 'object' && 'data' in (out as Record<string, unknown>)) {
        return out as { data: unknown };
      }
      return { data: out };
    },
    userFacingName: () => name,
    getToolUseSummary: (args) => {
      const brief = JSON.stringify(args ?? {}).slice(0, 60);
      return `${name}: ${brief}`;
    },
  });

  return { tool, name };
}
