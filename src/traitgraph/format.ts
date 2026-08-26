/**
 * traitgraph —— 把图/节点渲染成给 LLM 看的 markdown。
 * status/read 工具输出共用,避免到处拼字符串。
 */
import type { TraitNode, TraitEdge } from './schema.js';
import type { TraitGraphStore } from './store.js';

function statusBadge(n: TraitNode): string {
  switch (n.status) {
    case 'active': return '▶';
    case 'done': return '✓';
    case 'failed': return '✗';
    case 'abandoned': return '∅';
  }
}

export function renderNode(n: TraitNode): string {
  const lines = [
    `## ${statusBadge(n)} ${n.id} — ${n.status}`,
    `**目标(goal):** ${n.goal || '(none)'}`,
    `**计划(plan):** ${n.plan || '(none)'}`,
    `**方向(direction):** ${n.direction || '(none)'}`,
  ];
  if (n.summary) lines.push(`**现状(summary):** ${n.summary}`);
  if (n.keywords.length > 0) lines.push(`**keywords:** ${n.keywords.join(', ')}`);
  return lines.join('\n');
}

export function renderEdge(e: TraitEdge): string {
  const outcome = e.outcome === 'success' ? '✓成功' : '✗失败';
  const dead = e.dead ? ' [DEAD]' : '';
  return `- **${e.id}**${dead} ${e.outcome === 'success' ? '✓' : '✗'}: ${e.action} → ${e.result.slice(0, 120)}`;
}

/** 状态视图:frontier + 主路径 + 全部节点 + 死边 */
export function renderStatus(store: TraitGraphStore): string {
  const nodes = store.listNodes();
  if (nodes.length === 0) {
    return '尚无思考轨迹。用 TraitGraph(action=\'plan\', goal, plan, direction) 开新目标。';
  }

  const out: string[] = [];
  const frontier = store.getFrontier();
  if (frontier) {
    out.push(`**当前前沿(frontier):** ${statusBadge(frontier)} ${frontier.id} — ${frontier.goal.slice(0, 60)}`);
    const path = store.pathToFrontier();
    if (path.length > 0) {
      out.push(`**主路径:** ${path.map(n => `${n.id}(${n.status})`).join(' → ')}`);
    }
  } else {
    out.push('**当前前沿:** (none)');
  }

  const deadEdges = store.listEdges().filter(e => e.dead);
  out.push(`\n**节点 (${nodes.length}):**`);
  for (const n of nodes) {
    out.push(`- ${statusBadge(n)} ${n.id} [${n.status}] ${n.goal.slice(0, 50)}${n.keywords.length ? ` — \`${n.keywords.join(',')}\`` : ''}`);
  }

  const liveEdges = store.listEdges().filter(e => !e.dead);
  out.push(`\n**边 (${liveEdges.length} 活跃):**`);
  for (const e of liveEdges) out.push(renderEdge(e));

  if (deadEdges.length > 0) {
    out.push(`\n**已标死 (${deadEdges.length}):**`);
    for (const e of deadEdges) out.push(renderEdge(e));
  }

  return out.join('\n');
}

/** 全文视图:所有节点 + 所有边(召回注入/手动导出用) */
export function renderGraph(store: TraitGraphStore): string {
  const nodes = store.listNodes();
  if (nodes.length === 0) return '(empty trait graph)';

  const out: string[] = [`# 思考-执行轨迹图 (${nodes.length} 节点)`];
  for (const n of nodes) {
    out.push(`\n${renderNode(n)}`);
  }
  const edges = store.listEdges();
  if (edges.length > 0) {
    out.push('\n## 边(做了什么 → 结果)');
    for (const e of edges) out.push(renderEdge(e));
  }
  return out.join('\n');
}
