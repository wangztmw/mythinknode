/**
 * 会话名字数预算 —— 纯逻辑，不碰磁盘。
 *
 * 为什么单独一个模块：字数规则有三个消费点（即时命名 / LLM 精修 / 尾缀），
 * 分散写很容易各自漂移。集中一处，改预算只改常量。
 *
 * 为什么要有上限：会话名是「唯一辨认手段」，但只需「够用来区分」。
 * 实测历史会话名最长 180 字（旧版累积式命名），33 字（base12+尾缀20）的
 * 名字在 80 列终端里也放不下一行。超过「能区分」长度之后，每多一个字都是负收益。
 */

/** 会话名总字数上限（不含 `YYYYMMDD-HHMM-` 时间前缀） */
export const NAME_MAX_CHARS = 15;

/** 有尾缀时，基础名的份额（8 + 1 分隔符 + 6 尾缀 = 15） */
export const BASE_SHARE_WITH_SUFFIX = 8;

/** 尾缀份额 */
export const SUFFIX_SHARE = 6;

/**
 * 按 Unicode 码点截断。
 *
 * 不能用 `str.slice(0, n)`：它按 UTF-16 码元计数，会把 emoji（代理对）
 * 或某些组合字符切成半个 —— 产生乱码并可能让目录名无法创建。
 */
export function truncateChars(text: string, max: number): string {
  if (max <= 0) return '';
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * 分配基础名与尾缀的份额。
 *
 * - 无尾缀：基础名可以独占全部预算（刚开会话时名字就是全部信息）
 * - 有尾缀：基础名让位，因为前几个字已经传递了主要意图，
 *   「后来聊到哪」比基础名的后半段更有信息量
 */
export function allocateShares(hasSuffix: boolean): { base: number; suffix: number } {
  if (!hasSuffix) return { base: NAME_MAX_CHARS, suffix: 0 };
  return { base: BASE_SHARE_WITH_SUFFIX, suffix: SUFFIX_SHARE };
}

/**
 * 拼装最终名字（不含时间前缀）。保证总长 ≤ NAME_MAX_CHARS。
 *
 * 尾缀为空 / 全是分隔符时退回纯基础名，避免出现 `xxx-` 这种尾巴。
 */
export function composeName(baseName: string, suffix: string): string {
  const base = truncateChars(baseName, NAME_MAX_CHARS);
  const tail = truncateChars(suffix.replace(/^-+|-+$/g, ''), SUFFIX_SHARE);
  if (!tail) return base;
  // 基础名此时可能仍占满 15 字（例如已有名字是旧的 llm 终态），再收一次
  const room = NAME_MAX_CHARS - tail.length - 1;   // -1 是连字符
  const head = truncateChars(base, Math.max(1, room));
  return `${head}-${tail}`;
}

/** 名字（不含时间前缀）的字数。用码点计数，与 truncateChars 口径一致。 */
export function nameLength(name: string): number {
  return Array.from(name).length;
}

/** 从完整 id（`YYYYMMDD-HHMM-名字`）里取出名字部分 */
export function stripTimePrefix(id: string): string {
  return id.replace(/^\d{8}-\d{4}-/, '');
}
