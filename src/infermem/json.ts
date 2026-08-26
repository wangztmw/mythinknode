/**
 * 容错 JSON 解析 —— 思路同 reflector.ts,但数组感知(抽取输出可能是 {atoms:[...]} 或裸数组)。
 * LLM 输出常被 max_tokens 截断,需修复未闭合字符串/括号。
 */

/** 引号感知地提取第一个完整闭合的 { ... } 或 [ ... ] */
export function extractJsonBlock(text: string): string | null {
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  let start = -1, open = '', close = '';
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) { start = objStart; open = '{'; close = '}'; }
  else if (arrStart >= 0) { start = arrStart; open = '['; close = ']'; }
  if (start < 0) return null;

  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 修复被截断的 JSON:闭合未结束的字符串,补齐缺失的 } 和 ] */
function closeTruncatedJson(s: string): string {
  let out = '';
  let inString = false, escaped = false;
  let brace = 0, bracket = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    out += c;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
  }
  if (inString) out += '"';
  while (bracket-- > 0) out += ']';
  while (brace-- > 0) out += '}';
  return out;
}

/** 截掉末尾未完成的键值对,作为二次兜底 */
function cutIncompleteTail(s: string): string | null {
  let inString = false, escaped = false, lastComma = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === ',') lastComma = i;
  }
  if (lastComma < 0) return null;
  return s.slice(0, lastComma);
}

/** 分层尝试解析:完整块 → 截断修复 → 二次兜底。全失败返回 null */
export function parseJsonLenient(text: string): unknown | null {
  const block = extractJsonBlock(text);
  if (block) { try { return JSON.parse(block); } catch { /* fall through */ } }

  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const candidate = text.slice(start);

  const closed = closeTruncatedJson(candidate);
  try { return JSON.parse(closed); } catch { /* fall through */ }

  const cut = cutIncompleteTail(candidate);
  if (cut) {
    const closed2 = closeTruncatedJson(cut);
    try { return JSON.parse(closed2); } catch { /* give up */ }
  }
  return null;
}
