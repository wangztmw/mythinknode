/**
 * 工具参数容错解析
 *
 * OpenAI 兼容 API 的 `tool_calls[].function.arguments` 是「模型生成的 JSON 字符串」，
 * 经常不是合法 JSON：单引号、尾逗号、裸 key、注释、```json 围栏、前后夹说明文字。
 * 裸 `JSON.parse` 会抛 SyntaxError，冒泡到 query_loop 变成
 * `LLM call failed: Unexpected token ''' ... is not valid JSON` 并把整轮对话打成 crashed。
 *
 * 这里做分层修复，仍然失败时也不抛，返回 { ok:false, error } 交给 query_loop
 * 作为工具结果反馈给模型（模型下一轮会自己重发合法 JSON）。
 */

export type ParsedToolArgs =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** 引号感知地截出第一个平衡的 {...} / [...] 块（前后夹带说明文字时用） */
export function extractBalanced(text: string): string | null {
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  let start = -1, open = '', close = '';
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) { start = objStart; open = '{'; close = '}'; }
  else if (arrStart >= 0) { start = arrStart; open = '['; close = ']'; }
  if (start < 0) return null;

  let depth = 0, quote = '', escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const LITERALS = new Set(['true', 'false', 'null']);
const BARE_WORD = /[A-Za-z_$]/;
const BARE_WORD_CHAR = /[A-Za-z0-9_$.\-]/;

/**
 * 把「像 JSON 但不是 JSON」的文本修成 JSON 文本：
 *   - 剥 ```json 围栏
 *   - 去掉 // 与 \/* *\/ 注释
 *   - 单引号字符串 → 双引号（并转义内部的 "，还原 \' ；裸换行/制表符转义）
 *   - 裸 key / 裸字符串值补双引号（true/false/null 与数字除外）
 *   - 去尾逗号
 * 修不了的结构（截断的 JSON）留给 JSON.parse 报错 → 上层反馈给模型重发。
 */
export function repairJsonText(src: string): string {
  let first = src.indexOf('`');
  let s = src;
  // 只处理成对围栏：```json ... ``` / ``` ... ```
  if (first >= 0 && s.indexOf('`', first + 3) > first) {
    s = s.replace(/```[A-Za-z0-9_-]*\s*/g, '').replace(/```/g, '');
  }

  let out = '';
  let lastSig = ''; // 最近一个「字符串外」的有效字符
  let i = 0;

  while (i < s.length) {
    const c = s[i];

    // 注释
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // 字符串（单引号或双引号）
    if (c === '"' || c === "'") {
      const quote = c;
      out += '"';
      i++;
      while (i < s.length) {
        const d = s[i];
        if (d === '\\') {
          const n = s[i + 1];
          if (n === undefined) { i++; break; }
          if (n === "'") { out += "'"; i += 2; continue; }      // \' 在 JSON 中非法
          if (n === '"') { out += '\\"'; i += 2; continue; }
          out += d + n; i += 2; continue;
        }
        if (d === quote) { out += '"'; i++; break; }
        if (d === '"' && quote === "'") { out += '\\"'; i++; continue; } // 单引号串里的 "
        if (d === '\n') { out += '\\n'; i++; continue; }
        if (d === '\r') { out += '\\r'; i++; continue; }
        if (d === '\t') { out += '\\t'; i++; continue; }
        out += d; i++;
      }
      lastSig = '"';
      continue;
    }

    // 裸词：可能是裸 key（后面跟 :）或裸字符串值（在 [ , : 之后）
    if (BARE_WORD.test(c) && (lastSig === '{' || lastSig === '[' || lastSig === ',' || lastSig === ':')) {
      let j = i;
      while (j < s.length && BARE_WORD_CHAR.test(s[j])) j++;
      const word = s.slice(i, j);
      let k = j;
      while (k < s.length && /\s/.test(s[k])) k++;
      const isLiteral = LITERALS.has(word);
      if (!isLiteral && (s[k] === ':' || lastSig === '[' || lastSig === ',' || lastSig === ':')) {
        out += `"${word}"`;
        lastSig = '"';
        i = j;
        continue;
      }
      out += word;
      lastSig = 'x';
      i = j;
      continue;
    }

    // 尾逗号
    if (c === ',') {
      let k = i + 1;
      while (k < s.length && /\s/.test(s[k])) k++;
      if (s[k] === '}' || s[k] === ']') { i++; continue; }
      out += c; lastSig = c; i++;
      continue;
    }

    if (!/\s/.test(c)) lastSig = c;
    out += c;
    i++;
  }
  // 落在字符串里没有闭合（被截断）——补一个引号，剩下的括号交给 parse 报错
  if (lastSig === '"') { /* nothing: string already closed above */ }
  return out;
}

function tryParse(s: string): { ok: true; value: unknown } | null {
  try { return { ok: true, value: JSON.parse(s) }; } catch { return null; }
}

/**
 * 解析模型给出的工具参数。
 * - 非字符串（已是对象） → 直接透传
 * - 空串/纯空白 → {}
 * - 否则：原样 → 摘平衡块 → 修复后 → 修复+摘块，逐层尝试
 * 全失败返回 { ok:false, error }，**不抛异常**。
 */
export function parseToolArgs(raw: unknown): ParsedToolArgs {
  if (raw == null) return { ok: true, value: {} };
  if (typeof raw !== 'string') return { ok: true, value: raw };

  const text = raw.trim();
  if (!text) return { ok: true, value: {} };

  const direct = tryParse(text);
  if (direct) return direct;

  const block = extractBalanced(text);
  if (block) {
    const p = tryParse(block);
    if (p) return p;
  }

  const repaired = repairJsonText(text);
  const p2 = tryParse(repaired);
  if (p2) return p2;

  const repairedBlock = extractBalanced(repaired);
  if (repairedBlock) {
    const p3 = tryParse(repairedBlock);
    if (p3) return p3;
  }

  // 取 V8 的原生错误信息（含它是怎么理解这段文本的），但不让它抛
  let reason = 'not valid JSON';
  try { JSON.parse(text); } catch (e) { reason = (e as Error).message; }
  return { ok: false, error: reason };
}
