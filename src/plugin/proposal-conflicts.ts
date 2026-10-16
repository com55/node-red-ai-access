/**
 * Cross-token conflict detection for pending proposals on the same flow.
 * Like a git conflict check: same-rev peers or truly overlapping edits.
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

const EXPIRED_REASON =
  'Proposal expired: the live flow revision moved past expectedRev. Re-read the flow and resubmit.';

/**
 * Auto-close pending proposals whose expectedRev no longer matches `liveRev`
 * (they can no longer be approved). Returns how many were closed.
 */
export function expireStalePendingProposals(
  store: ProposalStore,
  liveRev: string,
  options: { flowId?: string } = {}
): number {
  let closed = 0;
  for (const proposal of store.list()) {
    if (proposal.status !== 'pending') continue;
    if (options.flowId && proposal.payload.flowId !== options.flowId) continue;
    if (proposal.expectedRev === liveRev) continue;
    try {
      store.markClosed(proposal.id, 'expired', EXPIRED_REASON);
      closed += 1;
    } catch {
      // Race: already decided — skip.
    }
  }
  return closed;
}

/**
 * After a successful approve, mark other pending proposals on the same flow
 * as `superseded` (they can no longer be approved against the new rev).
 */
export function supersedePendingOnFlow(
  store: ProposalStore,
  flowId: string,
  approvedId: string,
  approvedRev: string
): number {
  const reason =
    `Superseded by approved proposal ${approvedId} (resultRev ${approvedRev}). ` +
    'Re-read the flow and resubmit if still needed.';
  let closed = 0;
  for (const proposal of store.list()) {
    if (
      proposal.id === approvedId ||
      proposal.status !== 'pending' ||
      proposal.payload.flowId !== flowId
    ) {
      continue;
    }
    try {
      store.markClosed(proposal.id, 'superseded', reason);
      closed += 1;
    } catch {
      // Race: already decided — skip.
    }
  }
  return closed;
}

/**
 * Pending proposals on the same flowId that may conflict when approved.
 * Includes same-`expectedRev` peers and peers with true node/field overlap.
 * Pending peers on a different rev with no overlap are skipped (in practice
 * they are auto-closed as `expired` before this runs). Closed proposals are
 * never conflicts.
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
    const sameRev = other.expectedRev === proposal.expectedRev;
    const trulyOverlapping = overlap.nodeIds.length > 0;

    if (!sameRev && !trulyOverlapping) {
      continue;
    }

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
  const out: Record<string, unknown> = {};
  if (result.conflictingProposals.length > 0) {
    out.conflictingProposals = result.conflictingProposals;
    out.warning =
      'Other pending proposals touch the same flow — approve order may conflict (like a git merge).';
  }
  return out;
}

/**
 * `autoClosedCount` response field: how many pending proposals this request
 * auto-closed as `expired` (live rev moved past their expectedRev). Omitted
 * when zero.
 */
export function autoClosedFields(count: number): { autoClosedCount?: number } {
  return count > 0 ? { autoClosedCount: count } : {};
}
