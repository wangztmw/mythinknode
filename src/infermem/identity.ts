/**
 * 身份与合并策略 —— infermem 跨书「同构化合并」的核心。
 *
 * identityKey 是全局合并键:
 *   - 可合并 kind(concept/definition/theorem/formula/table):
 *       `kind:scope路径:规范名` → 同名同义跨书合并成一个节点
 *   - case(永不合并):上述键 + 内容哈希 → 每个案例都是独立节点(不同案例并存)
 */
import { createHash } from 'node:crypto';
import type { AtomKind } from './schema.js';

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKC')                            // 全角→半角,兼容字符
    .replace(/['’]/g, '')                          // Bayes' → bayes
    .replace(/[^a-z0-9一-鿿]+/g, '-')     // 非字母数字/汉字 → 连字符
    .replace(/^-+|-+$/g, '')                      // 去首尾连字符
    .replace(/-{2,}/g, '-');                      // 连续连字符坍缩
}

export function buildIdentityKey(
  kind: AtomKind,
  scope: string[],
  name: string,
  statement?: string,
): string {
  const base = `${kind}:${scope.map(normalizeName).join('.')}:${normalizeName(name)}`;
  if (kind === 'case') {
    const h = createHash('sha1').update(statement ?? name).digest('hex').slice(0, 12);
    return `${base}:${h}`;
  }
  return base;
}

/** case 永不合并;其余 kind 同 identityKey 即合并 */
export function isMergeable(kind: AtomKind): boolean {
  return kind !== 'case';
}

/** 稳定全局 ID:由 identityKey 派生,幂等 —— 重跑不产生新 id */
export function deriveAtomId(identityKey: string): string {
  return 'a' + createHash('sha1').update(identityKey).digest('hex').slice(0, 16);
}

export function deriveEdgeId(from: string, relation: string, to: string): string {
  return 'e' + createHash('sha1').update(`${from}|${relation}|${to}`).digest('hex').slice(0, 16);
}
