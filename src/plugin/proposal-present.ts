/**
 * Human-friendly proposal title, displayName, and reviewUrl helpers.
 */

import type { FlowNode, FlowTab } from '../runtime/types.js';
import type { Proposal } from '../storage/proposals.js';

/** Max length for a stored/submitted proposal title. */
export const PROPOSAL_TITLE_MAX = 80;

export interface PresentedProposal extends Proposal {
  /** Always set on API responses (stored or auto-generated). */
  title: string;
  /** `title · <local submitted datetime>`, e.g. `Edit fn1 (function) · 16 Oct 01:35`. */
  displayName: string;
  /** Deep link that opens/scrolls/highlights the proposal on /mcp. */
  reviewUrl: string;
}

function nodeLabel(node: FlowNode): string {
  if (typeof node.name === 'string' && node.name.trim()) {
    return node.name.trim();
  }
  if (typeof node.label === 'string' && node.label.trim()) {
    return node.label.trim();
  }
  return '';
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

/**
 * Sanitize an optional AI-supplied title: strip nulls/control chars, trim,
 * collapse whitespace, cap at PROPOSAL_TITLE_MAX. Empty → undefined.
 */
export function sanitizeProposalTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const cleaned = raw
    .replace(/\0/g, '')
    // eslint-disable-next-line no-control-regex -- intentional control-char strip
    .replace(/[\u0001-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROPOSAL_TITLE_MAX)
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Format ISO timestamp in Node-RED server local time as `16 Oct 01:35`.
 */
export function formatProposalSubmittedAt(iso: string, at: Date = new Date(iso)): string {
  const d = Number.isNaN(at.getTime()) ? new Date(iso) : at;
  if (Number.isNaN(d.getTime())) {
    return iso.slice(0, 16);
  }
  const day = d.getDate();
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const month = months[d.getMonth()] ?? 'Jan';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month} ${hh}:${mm}`;
}

function quoteName(name: string): string {
  return `"${name.replace(/"/g, "'")}"`;
}

function describeOneNode(kind: 'Add' | 'Remove' | 'Edit', node: FlowNode): string {
  const name = nodeLabel(node);
  const type = node.type || 'node';
  if (kind === 'Edit') {
    return name ? `Edit ${name} (${type})` : `Edit ${type}`;
  }
  if (name) {
    return `${kind} ${type} ${quoteName(name)}`;
  }
  return `${kind} ${type}`;
}

function nodeContentChanged(prev: FlowNode, next: FlowNode): boolean {
  const ignore = new Set(['x', 'y', 'w', 'h', 'g', 'id', 'z']);
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (ignore.has(key)) continue;
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      return true;
    }
  }
  return false;
}

function classifyFlowChanges(
  before: Map<string, FlowNode>,
  after: Map<string, FlowNode>
): { added: FlowNode[]; removed: FlowNode[]; modified: FlowNode[] } {
  const added: FlowNode[] = [];
  const removed: FlowNode[] = [];
  const modified: FlowNode[] = [];
  for (const [id, node] of after) {
    if (!before.has(id)) {
      added.push(node);
    }
  }
  for (const [id, node] of before) {
    if (!after.has(id)) {
      removed.push(node);
    }
  }
  for (const [id, node] of after) {
    const prev = before.get(id);
    if (prev && nodeContentChanged(prev, node)) {
      modified.push(node);
    }
  }
  return { added, removed, modified };
}

function titleFromSingleChange(changes: {
  added: FlowNode[];
  removed: FlowNode[];
  modified: FlowNode[];
}): string | undefined {
  const { added, removed, modified } = changes;
  const total = added.length + removed.length + modified.length;
  if (total !== 1) {
    return undefined;
  }
  if (added[0]) return describeOneNode('Add', added[0]);
  if (removed[0]) return describeOneNode('Remove', removed[0]);
  if (modified[0]) return describeOneNode('Edit', modified[0]);
  return undefined;
}

function titleFromMultiChange(changes: {
  added: FlowNode[];
  removed: FlowNode[];
  modified: FlowNode[];
}): string {
  const { added, removed, modified } = changes;
  const total = added.length + removed.length + modified.length;
  if (modified.length === total && modified.length > 1) {
    return `Edit ${modified.length} nodes`;
  }
  if (added.length === total && added.length > 1) {
    return `Add ${added.length} nodes`;
  }
  if (removed.length === total && removed.length > 1) {
    return `Remove ${removed.length} nodes`;
  }
  return `Change ${total} nodes`;
}

function flowLabelHint(
  afterFlow: Partial<FlowTab>,
  baseFlow: Partial<FlowTab> | undefined
): string {
  if (typeof afterFlow.label === 'string' && afterFlow.label.trim()) {
    return afterFlow.label.trim();
  }
  if (typeof baseFlow?.label === 'string' && baseFlow.label.trim()) {
    return baseFlow.label.trim();
  }
  return '';
}

/**
 * Auto-generate a short title from base vs proposed flow changes.
 * Examples: `Edit fn1 (function)`, `Add template "demo-html"`, `Edit 3 nodes`.
 */
export function autoGenerateProposalTitle(
  baseFlow: Partial<FlowTab> | undefined,
  afterFlow: Partial<FlowTab>
): string {
  const changes = classifyFlowChanges(collectNodes(baseFlow ?? {}), collectNodes(afterFlow));
  const total = changes.added.length + changes.removed.length + changes.modified.length;
  if (total === 0) {
    const label = flowLabelHint(afterFlow, baseFlow);
    return label ? `Update flow ${quoteName(label)}` : 'Update flow';
  }
  return titleFromSingleChange(changes) ?? titleFromMultiChange(changes);
}

export function buildProposalDisplayName(title: string, createdAtIso: string): string {
  return `${title} · ${formatProposalSubmittedAt(createdAtIso)}`;
}

/** Relative review URL that opens the proposal on the /mcp admin page. */
export function buildProposalReviewUrl(proposalId: string): string {
  return `/mcp#proposal=${encodeURIComponent(proposalId)}`;
}

/**
 * Resolve the effective title for a proposal (stored, or auto from base/payload).
 */
export function resolveProposalTitle(proposal: Proposal): string {
  const stored = sanitizeProposalTitle(proposal.title);
  if (stored) {
    return stored;
  }
  return autoGenerateProposalTitle(proposal.baseFlow, proposal.payload.flow);
}

/** Attach title, displayName, and reviewUrl for API / MCP responses. */
export function presentProposal(proposal: Proposal): PresentedProposal {
  const title = resolveProposalTitle(proposal);
  return {
    ...proposal,
    title,
    displayName: buildProposalDisplayName(title, proposal.createdAt),
    reviewUrl: buildProposalReviewUrl(proposal.id),
  };
}

export function presentProposals(proposals: Proposal[]): PresentedProposal[] {
  return proposals.map(presentProposal);
}
