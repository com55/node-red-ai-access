/**
 * Cross-token conflict detection for pending proposals on the same flow.
 * Like a git conflict check: any pending sibling (any access link) can conflict.
 */

import type { FlowNode, FlowTab } from '../runtime/types.js';
import type { Proposal, ProposalStore } from '../storage/proposals.js';

import { buildProposalDisplayName, resolveProposalTitle } from './proposal-present.js';

const IGNORE_TOUCH_KEYS = new Set(['x', 'y', 'w', 'h', 'g', 'id', 'z']);

/** Fields changed on a node (`*` = added or removed wholesale). */
export type NodeTouchMap = Map<string, Set<string>>;

export interface ConflictingProposalRef {
  id: string;
  title: string;
  displayName: string;
  /** True when the conflicting proposal was created by the same access link. */
  mine: boolean;
  /** Node ids touched by both proposals. */
  overlappingNodeIds?: string[];
  /** Shared node+field overlaps when both proposals modify the same fields. */
  overlappingFields?: { nodeId: string; fields: string[] }[];
}

export interface ConflictingProposalsResult {
  conflictingProposals: ConflictingProposalRef[];
}

function collectNodes(flow: Partial<FlowTab>): Map<string, FlowNode> {
  const map = new Map<string, FlowNode>();
  for (const node of flow.nodes ?? []) {
    map.set(node.id, node);
  }
  for (const node of flow.configs ?? []) {
    map.set(node.id, node);
  }
  return map;
}

function changedFieldKeys(before: FlowNode, after: FlowNode): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const key of keys) {
    if (IGNORE_TOUCH_KEYS.has(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      out.push(key);
    }
  }
  return out.sort();
}

/** Map nodeId → changed field names (`*` for add/remove). */
export function computeProposalTouches(proposal: Proposal): NodeTouchMap {
  const before = collectNodes(proposal.baseFlow ?? {});
  const after = collectNodes(proposal.payload.flow);
  const touches: NodeTouchMap = new Map();

  for (const [id, node] of after) {
    const prev = before.get(id);
    if (!prev) {
      touches.set(id, new Set(['*']));
      continue;
    }
    const fields = changedFieldKeys(prev, node);
    if (fields.length > 0) {
      touches.set(id, new Set(fields));
    }
  }
  for (const [id] of before) {
    if (!after.has(id)) {
      touches.set(id, new Set(['*']));
    }
  }
  return touches;
}

function overlapBetween(
  a: NodeTouchMap,
  b: NodeTouchMap
): { nodeIds: string[]; fields: { nodeId: string; fields: string[] }[] } {
  const nodeIds: string[] = [];
  const fields: { nodeId: string; fields: string[] }[] = [];
  for (const [nodeId, aFields] of a) {
    const bFields = b.get(nodeId);
    if (!bFields) continue;
    nodeIds.push(nodeId);
    const shared: string[] = [];
    for (const f of aFields) {
      if (f === '*') {
        // Wholesale touch overlaps any field on the other side.
        shared.push(...[...bFields].filter(x => x !== '*'));
        if (bFields.has('*')) shared.push('*');
        continue;
      }
      if (bFields.has(f) || bFields.has('*')) {
        shared.push(f);
      }
    }
    const uniq = [...new Set(shared)].sort();
    if (uniq.length > 0) {
      fields.push({ nodeId, fields: uniq });
    }
  }
  nodeIds.sort();
  return { nodeIds, fields };
}

/**
 * Pending proposals on the same flowId (any token / expectedRev) that may
 * conflict with `proposal` when approved. Excludes `proposal` itself.
 */
export function findConflictingProposals(
  store: ProposalStore,
  proposal: Proposal,
  callerLinkId?: string
): ConflictingProposalsResult {
  const selfTouches = computeProposalTouches(proposal);
  const conflictingProposals: ConflictingProposalRef[] = [];

  for (const other of store.list()) {
    if (
      other.id === proposal.id ||
      other.status !== 'pending' ||
      other.payload.flowId !== proposal.payload.flowId
    ) {
      continue;
    }
    const title = resolveProposalTitle(other);
    const mine = callerLinkId
      ? other.createdBy.linkId === callerLinkId
      : other.createdBy.linkId === proposal.createdBy.linkId;
    const overlap = overlapBetween(selfTouches, computeProposalTouches(other));
    const ref: ConflictingProposalRef = {
      id: other.id,
      title,
      displayName: buildProposalDisplayName(title, other.createdAt),
      mine,
    };
    if (overlap.nodeIds.length > 0) {
      ref.overlappingNodeIds = overlap.nodeIds;
    }
    if (overlap.fields.length > 0) {
      ref.overlappingFields = overlap.fields;
    }
    conflictingProposals.push(ref);
  }

  return { conflictingProposals };
}

/** Spread conflict warning fields onto a JSON response (omit when empty). */
export function conflictWarningFields(result: ConflictingProposalsResult): Record<string, unknown> {
  if (result.conflictingProposals.length === 0) {
    return {};
  }
  return {
    conflictingProposals: result.conflictingProposals,
    warning:
      'Other pending proposals touch the same flow — approve order may conflict (like a git merge).',
  };
}
