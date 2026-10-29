/**
 * Cross-token conflict detection for pending proposals on the same flow.
 * Only overlapping field edits warn; disjoint edits auto-merge.
 */

import type { FlowNode, FlowTab } from '../runtime/types.js';
import {
  isOpenProposalStatus,
  proposalOwnerId,
  type Proposal,
  type ProposalStore,
} from '../storage/proposals.js';

import { buildProposalDisplayName, resolveProposalTitle } from './proposal-present.js';
import { changedFieldPaths } from './proposal-rebase.js';

const IGNORE_TOUCH_KEYS = new Set(['x', 'y', 'id', 'z']);

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

function changedFieldKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  return changedFieldPaths(before, after).filter(key => !IGNORE_TOUCH_KEYS.has(key));
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
  const tabBefore = Object.fromEntries(
    ['label', 'disabled', 'info', 'env'].map(key => [
      key,
      (proposal.baseFlow as Record<string, unknown> | undefined)?.[key],
    ])
  );
  const tabAfter = Object.fromEntries(
    ['label', 'disabled', 'info', 'env'].map(key => [
      key,
      (proposal.payload.flow as Record<string, unknown>)[key],
    ])
  );
  const tabFields = changedFieldKeys(tabBefore, tabAfter);
  if (tabFields.length > 0) touches.set(proposal.payload.flowId, new Set(tabFields));
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
    const shared: string[] = [];
    for (const f of aFields) {
      if (f === '*') {
        // Wholesale touch overlaps any field on the other side.
        shared.push(...[...bFields].filter(x => x !== '*'));
        if (bFields.has('*')) shared.push('*');
        continue;
      }
      if (
        bFields.has('*') ||
        [...bFields].some(
          other =>
            other === f ||
            other.startsWith(`${f}.`) ||
            f.startsWith(`${other}.`) ||
            other.startsWith(`${f}[`) ||
            f.startsWith(`${other}[`)
        )
      ) {
        shared.push(f);
      }
    }
    const uniq = [...new Set(shared)].sort();
    if (uniq.length > 0) {
      nodeIds.push(nodeId);
      fields.push({ nodeId, fields: uniq });
    }
  }
  nodeIds.sort();
  return { nodeIds, fields };
}

/**
 * Open proposals on the same flowId that touch the same fields (approving one
 * will put the other into `conflict`). Non-overlapping peers are skipped:
 * they auto-rebase. Closed proposals are never conflicts.
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
      !isOpenProposalStatus(other.status) ||
      other.payload.flowId !== proposal.payload.flowId
    ) {
      continue;
    }
    const title = resolveProposalTitle(other);
    const mine = callerLinkId
      ? proposalOwnerId(other.createdBy) === callerLinkId
      : proposalOwnerId(other.createdBy) === proposalOwnerId(proposal.createdBy);
    const overlap = overlapBetween(selfTouches, computeProposalTouches(other));
    // Non-overlapping peers auto-rebase after either is approved — no warning.
    if (overlap.nodeIds.length === 0) {
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
 * `autoClosedCount` response field: how many open proposals this request
 * auto-closed as `expired` (older than the proposal TTL). Omitted when zero.
 */
export function autoClosedFields(count: number): { autoClosedCount?: number } {
  return count > 0 ? { autoClosedCount: count } : {};
}
