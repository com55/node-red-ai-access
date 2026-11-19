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

/** A move requires valid editor positions and no other changed fields. */
export function isMoveOnly(
  before: FlowNode,
  after: FlowNode,
  keys: readonly string[] = changedNodeKeys(before, after)
): boolean {
  return (
    keys.length > 0 &&
    keys.every(key => key === 'x' || key === 'y') &&
    [before.x, before.y, after.x, after.y].every(
      value => typeof value === 'number' && Number.isFinite(value)
    ) &&
    (before.x !== after.x || before.y !== after.y)
  );
}

export function flowChangeCounts(before: Partial<FlowTab>, after: Partial<FlowTab>) {
  const collect = (flow: Partial<FlowTab>) =>
    new Map([...(flow.nodes ?? []), ...(flow.configs ?? [])].map(node => [node.id, node]));
  const left = collect(before),
    right = collect(after);
  const changed = [...right]
    .filter(([id]) => left.has(id))
    .map(([id, node]) => {
      const prev = left.get(id)!;
      const keys = changedNodeKeys(prev, node);
      return { keys, moved: isMoveOnly(prev, node, keys) };
    });
  return {
    added: [...right.keys()].filter(id => !left.has(id)).length,
    removed: [...left.keys()].filter(id => !right.has(id)).length,
    modified: changed.filter(change => change.keys.length > 0 && !change.moved).length,
    moved: changed.filter(change => change.moved).length,
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
