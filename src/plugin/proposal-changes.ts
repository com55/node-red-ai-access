/** Shared node classification for proposal summaries and the review diff. */
import type { FlowNode, FlowTab } from '../runtime/types.js';
import type { Proposal } from '../storage/proposals.js';

/** Stable JSON comparison ignores object key order while retaining array order. */
function comparable(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(JSON.stringify(value));
  if (Array.isArray(value)) return `[${value.map(comparable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${comparable(record[key])}`)
    .join(',')}}`;
}

/** Include wiring and editor positions: both are reviewable proposal changes. */
export function changedNodeKeys(before: FlowNode, after: FlowNode): string[] {
  const ignored = new Set(['id', 'z', 'w', 'h', 'g']);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !ignored.has(key) && comparable(before[key]) !== comparable(after[key]))
    .sort();
}

export function flowChangeCounts(before: Partial<FlowTab>, after: Partial<FlowTab>) {
  const collect = (flow: Partial<FlowTab>) =>
    new Map([...(flow.nodes ?? []), ...(flow.configs ?? [])].map(node => [node.id, node]));
  const left = collect(before),
    right = collect(after);
  return {
    added: [...right.keys()].filter(id => !left.has(id)).length,
    removed: [...left.keys()].filter(id => !right.has(id)).length,
    modified: [...right].filter(
      ([id, node]) => left.has(id) && changedNodeKeys(left.get(id)!, node).length > 0
    ).length,
  };
}

export function proposalChangeCounts(proposal: Proposal, fallbackBefore?: Partial<FlowTab>) {
  return {
    ...flowChangeCounts(proposal.baseFlow ?? fallbackBefore ?? {}, proposal.payload.flow),
    conflict:
      proposal.rebase?.state === 'conflict'
        ? new Set(proposal.rebase.conflicts.map(conflict => conflict.nodeId)).size
        : 0,
  };
}
