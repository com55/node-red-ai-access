/**
 * Build a human-readable proposal vs current-flow diff for the /mcp UI.
 */

import { FlowNotFoundError } from '../runtime/errors.js';
import type { FlowAdapter, FlowNode, FlowTab } from '../runtime/types.js';
import type { Proposal } from '../storage/proposals.js';

import { diffLines, type LineDiffEntry } from './line-diff.js';

/** Node property keys treated as multi-line text for line diffs. */
const TEXT_PROPERTY_KEYS = new Set([
  'func',
  'template',
  'info',
  'payload',
  'code',
  'text',
  'format',
  'syntax',
]);

/** Keys ignored when comparing nodes (layout / wiring noise). */
const IGNORE_NODE_KEYS = new Set(['x', 'y', 'w', 'h', 'wires', 'g']);

export interface NodeRef {
  id: string;
  type: string;
  name?: string;
}

export interface ScalarPropertyChange {
  key: string;
  kind: 'scalar';
  before: unknown;
  after: unknown;
}

export interface TextPropertyChange {
  key: string;
  kind: 'text';
  before: string;
  after: string;
  lines: LineDiffEntry[];
}

export type PropertyChange = ScalarPropertyChange | TextPropertyChange;

export interface ModifiedNodeDiff {
  id: string;
  type: string;
  name?: string;
  changes: PropertyChange[];
}

export interface ProposalDiffResult {
  proposalId: string;
  flowId: string;
  expectedRev: string;
  currentRev: string;
  /** True when expectedRev !== currentRev (approve would fail with revision conflict). */
  baseRevStale: boolean;
  summary: {
    added: number;
    removed: number;
    modified: number;
    tabChanges: string[];
  };
  /** Added nodes with full property changes (text fields as all-added line diffs). */
  added: ModifiedNodeDiff[];
  /** Removed nodes with full property changes (text fields as all-removed line diffs). */
  removed: ModifiedNodeDiff[];
  modified: ModifiedNodeDiff[];
}

function nodeName(node: FlowNode): string | undefined {
  if (typeof node.name === 'string' && node.name.length > 0) {
    return node.name;
  }
  if (typeof node.label === 'string' && node.label.length > 0) {
    return node.label;
  }
  return undefined;
}

/**
 * Snapshot every comparable property of a node as added or removed changes
 * so reviewers can see full content (including long template/func text).
 */
function snapshotNodeChanges(node: FlowNode, side: 'added' | 'removed'): PropertyChange[] {
  const changes: PropertyChange[] = [];
  const keys = [...Object.keys(node)].sort();
  for (const key of keys) {
    if (IGNORE_NODE_KEYS.has(key) || key === 'id' || key === 'z') {
      continue;
    }
    const value = node[key];
    const text = asText(value);
    if (TEXT_PROPERTY_KEYS.has(key) && text !== null) {
      if (side === 'added') {
        changes.push({
          key,
          kind: 'text',
          before: '',
          after: text,
          lines: diffLines('', text),
        });
      } else {
        changes.push({
          key,
          kind: 'text',
          before: text,
          after: '',
          lines: diffLines(text, ''),
        });
      }
      continue;
    }
    if (side === 'added') {
      changes.push({
        key,
        kind: 'scalar',
        before: null,
        after: value === undefined ? null : value,
      });
    } else {
      changes.push({
        key,
        kind: 'scalar',
        before: value === undefined ? null : value,
        after: null,
      });
    }
  }
  return changes;
}

function toNodeDetail(node: FlowNode, side: 'added' | 'removed'): ModifiedNodeDiff {
  const entry: ModifiedNodeDiff = {
    id: node.id,
    type: node.type,
    changes: snapshotNodeChanges(node, side),
  };
  const name = nodeName(node);
  if (name !== undefined) {
    entry.name = name;
  }
  return entry;
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

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

function compareNodes(before: FlowNode, after: FlowNode): PropertyChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: PropertyChange[] = [];
  for (const key of [...keys].sort()) {
    if (IGNORE_NODE_KEYS.has(key) || key === 'id' || key === 'z') {
      continue;
    }
    const left = before[key];
    const right = after[key];
    if (valuesEqual(left, right)) {
      continue;
    }
    const leftText = asText(left);
    const rightText = asText(right);
    if (TEXT_PROPERTY_KEYS.has(key) && (leftText !== null || rightText !== null)) {
      const beforeText = leftText ?? '';
      const afterText = rightText ?? '';
      changes.push({
        key,
        kind: 'text',
        before: beforeText,
        after: afterText,
        lines: diffLines(beforeText, afterText),
      });
      continue;
    }
    changes.push({
      key,
      kind: 'scalar',
      before: left === undefined ? null : left,
      after: right === undefined ? null : right,
    });
  }
  return changes;
}

function compareTabMeta(before: Partial<FlowTab>, after: Partial<FlowTab>): string[] {
  const keys = ['label', 'disabled', 'info', 'env'] as const;
  const out: string[] = [];
  for (const key of keys) {
    if (!valuesEqual(before[key], after[key])) {
      out.push(key);
    }
  }
  return out;
}

/**
 * Pure compare of a proposal payload against a current flow tab snapshot.
 */
export function buildProposalDiff(
  proposal: Proposal,
  current: { rev: string; flow: Partial<FlowTab> }
): ProposalDiffResult {
  const beforeNodes = collectNodes(current.flow);
  const afterNodes = collectNodes(proposal.payload.flow);

  const added: ModifiedNodeDiff[] = [];
  const removed: ModifiedNodeDiff[] = [];
  const modified: ModifiedNodeDiff[] = [];

  for (const [id, node] of afterNodes) {
    if (!beforeNodes.has(id)) {
      added.push(toNodeDetail(node, 'added'));
    }
  }
  for (const [id, node] of beforeNodes) {
    if (!afterNodes.has(id)) {
      removed.push(toNodeDetail(node, 'removed'));
    }
  }
  for (const [id, after] of afterNodes) {
    const before = beforeNodes.get(id);
    if (!before) {
      continue;
    }
    const changes = compareNodes(before, after);
    if (changes.length > 0) {
      const entry: ModifiedNodeDiff = {
        id,
        type: after.type || before.type,
        changes,
      };
      const name = nodeName(after) ?? nodeName(before);
      if (name !== undefined) {
        entry.name = name;
      }
      modified.push(entry);
    }
  }

  added.sort((a, b) => a.id.localeCompare(b.id));
  removed.sort((a, b) => a.id.localeCompare(b.id));
  modified.sort((a, b) => a.id.localeCompare(b.id));

  const tabChanges = compareTabMeta(current.flow, proposal.payload.flow);
  const currentRev = current.rev;
  const expectedRev = proposal.expectedRev;

  return {
    proposalId: proposal.id,
    flowId: proposal.payload.flowId,
    expectedRev,
    currentRev,
    baseRevStale: expectedRev !== currentRev,
    summary: {
      added: added.length,
      removed: removed.length,
      modified: modified.length,
      tabChanges,
    },
    added,
    removed,
    modified,
  };
}

/**
 * Load the live flow for a proposal and return a diff result.
 * Missing flows are treated as an empty tab (all proposal nodes are "added").
 */
export async function computeProposalDiff(
  proposal: Proposal,
  adapter: FlowAdapter
): Promise<ProposalDiffResult> {
  const flowId = proposal.payload.flowId;
  try {
    const snapshot = await adapter.getFlow(flowId);
    return buildProposalDiff(proposal, {
      rev: snapshot.rev,
      flow: snapshot.flow,
    });
  } catch (error) {
    if (error instanceof FlowNotFoundError) {
      let currentRev = proposal.expectedRev;
      try {
        const flows = await adapter.getFlows();
        currentRev = flows.rev;
      } catch {
        // keep expectedRev as best-effort current marker
      }
      return buildProposalDiff(proposal, {
        rev: currentRev,
        flow: { id: flowId, type: 'tab', nodes: [], configs: [] },
      });
    }
    throw error;
  }
}
