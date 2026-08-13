/**
 * NodeMindStore — 树状经验拓扑图的数据层。
 *
 * 核心设计：
 *   - 每个 Node 只有 keywords（字符串数组），声明"我跟什么有关"
 *   - 父节点不单独描述子节点范围——直接从 children[].keywords 聚合
 *   - 提供 keyword → childId[] 索引，去重后仍可追溯到源节点
 *   - attrs 内嵌在 node.json，不参与树导航
 *
 * 目录结构即树结构。index.json 提供 O(1) id → path 查找。
 * 存储路径: ~/.mythinknode/nodemind/
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';

// ---- 路径 ----

const BASE = join(homedir(), '.mythinknode', 'nodemind');
const indexP = () => join(BASE, 'index.json');
const nodeDir = (id: string) => { const idx = loadIndex(); const rel = idx[id]; return rel ? join(BASE, rel) : null; };
const nodePath = (id: string) => { const dir = nodeDir(id); return dir ? join(dir, 'node.json') : null; };

// ---- 类型 ----

export interface ChildEntry {
  id: string;
  title: string;
  keywords: string[];  // = 子节点的 keywords，路由匹配用
}

export type AttrType = 'code' | 'command' | 'config' | 'note';

export interface AttrNode {
  id: string;
  title: string;
  type: AttrType;
  content: string;  // 属性的简短描述
  fields: Record<string, string | number>;
}

export interface Node {
  id: string;
  title: string;
  keywords: string[];        // 核心检索字段 — "我跟什么有关"
  content: string;           // 正文：系统化的 Skill 文档，内联引用 attrs
  children: ChildEntry[];    // 子节点索引（不加载完整内容，只看 keywords）
  attrs: AttrNode[];         // 属性附件，纯存储，不参与导航
  sourceSession?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- 校验 ----

function validate(node: Node): string | null {
  if (!node.id) return 'missing id';
  if (!node.title) return 'missing title';
  if (!node.keywords || node.keywords.length === 0) return 'missing keywords';
  for (const attr of node.attrs) {
    if (!attr.id || !attr.title || !attr.type) return `attr "${attr.id || '?'}" missing id/title/type`;
    if (!['code', 'command', 'config', 'note'].includes(attr.type)) return `attr "${attr.id}" invalid type: ${attr.type}`;
  }
  return null;
}

// ---- 内部工具 ----

function loadIndex(): Record<string, string> {
  try { return existsSync(indexP()) ? JSON.parse(readFileSync(indexP(), 'utf-8')) : {}; } catch { return {}; }
}
function saveIndex(idx: Record<string, string>): void {
  if (!existsSync(BASE)) mkdirSync(BASE, { recursive: true });
  writeFileSync(indexP(), JSON.stringify(idx, null, 2));
}
function readNodeFile(absPath: string): Node | null {
  try { return existsSync(absPath) ? JSON.parse(readFileSync(absPath, 'utf-8')) as Node : null; } catch { return null; }
}
function writeNodeFile(absPath: string, node: Node): void {
  const dir = join(absPath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, JSON.stringify(node, null, 2));
}
function readDir(absDir: string): string[] {
  try {
    if (!existsSync(absDir)) return [];
    return readdirSync(absDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
}
function now(): string { return new Date().toISOString(); }
function uniq<T>(arr: T[]): T[] { return [...new Set(arr)]; }

// ---- 公开类 ----

export class NodeMindStore {
  private constructor() {}

  static init(): NodeMindStore {
    if (!existsSync(BASE)) mkdirSync(BASE, { recursive: true });
    const rootPath = join(BASE, 'root', 'node.json');
    if (!existsSync(rootPath)) {
      writeNodeFile(rootPath, {
        id: 'root', title: 'NodeMind Root', keywords: ['root'],
        content: 'Root node. Browse children to see available knowledge domains.',
        children: [], attrs: [], createdAt: now(), updatedAt: now(),
      });
      saveIndex({ root: 'root' });
    }
    return new NodeMindStore();
  }

  // ---- 读 ----

  getRoot(): Node { return this.getNode('root')!; }

  getNode(id: string): Node | null {
    const p = nodePath(id);
    return p ? readNodeFile(p) : null;
  }

  getChildren(parentId: string): Node[] {
    const dir = nodeDir(parentId);
    if (!dir) return [];
    return readDir(dir)
      .map(d => readNodeFile(join(dir, d, 'node.json')))
      .filter(Boolean) as Node[];
  }

  getChildIndex(parentId: string): ChildEntry[] {
    return this.getNode(parentId)?.children || [];
  }

  getAttrs(nodeId: string): AttrNode[] {
    return this.getNode(nodeId)?.attrs || [];
  }

  /**
   * 聚合所有子节点的 keywords，去重，保留 keyword → childId[] 映射。
   * 用于搜索路由：匹配到 keyword 后，知道该深入哪些子节点。
   */
  getChildKeywordMap(parentId: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const child of this.getChildIndex(parentId)) {
      for (const kw of child.keywords) {
        const ids = map.get(kw) || [];
        ids.push(child.id);
        map.set(kw, ids);
      }
    }
    return map;
  }

  /** 父节点下所有子节点 keywords 的去重列表（纯展示用） */
  getChildKeywordsFlat(parentId: string): string[] {
    const all: string[] = [];
    for (const child of this.getChildIndex(parentId)) {
      all.push(...child.keywords);
    }
    return uniq(all);
  }

  resolvePath(id: string): string | null { return nodeDir(id); }
  listAllIds(): string[] { return Object.keys(loadIndex()); }

  // ---- 写 ----

  upsertNode(node: Node, parentId: string = 'root'): void {
    const nowStr = now();
    const isNew = !node.createdAt;
    if (isNew) node.createdAt = nowStr;
    node.updatedAt = nowStr;
    if (!node.children) node.children = [];
    if (!node.attrs) node.attrs = [];

    const err = validate(node);
    if (err) throw new Error(err);

    const idx = loadIndex();
    if (!isNew) {
      const rel = idx[node.id];
      if (rel) {
        const parts = rel.split('/');
        if (parts.length >= 2 && idx[parts[parts.length - 2]]) parentId = parts[parts.length - 2];
      }
    }

    const parentDir = nodeDir(parentId) || join(BASE, parentId);
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

    const nodeAbsDir = join(parentDir, node.id);
    writeNodeFile(join(nodeAbsDir, 'node.json'), node);

    const relPath = relative(BASE, nodeAbsDir);
    idx[node.id] = relPath;
    saveIndex(idx);

    this._syncChildren(parentId);
  }

  deleteNode(id: string): void {
    if (id === 'root') return;
    const dir = nodeDir(id);
    if (!dir) return;

    const childIds = this._collectDescendantIds(id);
    const parentId = this._findParent(id);

    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

    const idx = loadIndex();
    delete idx[id];
    for (const cid of childIds) delete idx[cid];
    saveIndex(idx);

    if (parentId) this._syncChildren(parentId);
  }

  buildTreeSummary(nodeId: string = 'root', indent: number = 0): string {
    const node = this.getNode(nodeId);
    if (!node) return '';

    const prefix = '  '.repeat(indent);
    const icon = node.children.length > 0 ? '📁' : '📋';
    const extra: string[] = [];
    if (node.children.length > 0) extra.push(`${node.children.length} children`);
    if (node.attrs.length > 0) extra.push(`${node.attrs.length} attrs`);
    const badge = extra.length > 0 ? ` (${extra.join(', ')})` : '';

    let result = `${prefix}${icon} ${node.id}: ${node.title}${badge}\n`;
    result += `${prefix}  keywords: ${node.keywords.join(', ')}\n`;
    if (node.content) {
      const s = node.content.replace(/\n/g, ' ').slice(0, 120);
      result += `${prefix}  content: ${s}${node.content.length > 120 ? '...' : ''}\n`;
    }
    for (const child of node.children) {
      result += this.buildTreeSummary(child.id, indent + 1);
    }
    return result;
  }

  // ---- 内部 ----

  private _syncChildren(parentId: string): void {
    const parent = this.getNode(parentId);
    if (!parent) return;

    parent.children = this.getChildren(parentId).map(c => ({
      id: c.id, title: c.title,
      keywords: c.keywords,  // children[].keywords = 子节点自己的 keywords
    }));
    parent.updatedAt = now();
    const p = nodePath(parentId);
    if (p) writeNodeFile(p, parent);
  }

  private _collectDescendantIds(id: string): string[] {
    const ids: string[] = [];
    const node = this.getNode(id);
    if (!node) return ids;
    for (const child of node.children) {
      ids.push(child.id);
      ids.push(...this._collectDescendantIds(child.id));
    }
    return ids;
  }

  _findParent(id: string): string | null {
    const idx = loadIndex();
    const rel = idx[id];
    if (!rel) return null;
    const parts = rel.split('/');
    if (parts.length >= 2) {
      const c = parts[parts.length - 2];
      if (c && c !== id && idx[c]) return c;
    }
    return 'root';
  }
}

// ---- 单例 ----

let _instance: NodeMindStore | null = null;
let _searchLLM: { chat: any } | null = null;

export function getNodeMindStore(): NodeMindStore {
  if (!_instance) _instance = NodeMindStore.init();
  return _instance;
}

/** 设置搜索专用 LLM（轻量模型，如 deepseek-v4-flash） */
export function setSearchLLM(llm: { chat: any }): void {
  _searchLLM = llm;
}

/** 获取搜索专用 LLM，未设置时返回 null */
export function getSearchLLM(): { chat: any } | null {
  return _searchLLM;
}

export function _resetStore(): void { _instance = null; _searchLLM = null; }
