/**
 * Human-friendly proposal title, displayName, and reviewUrl helpers.
 */

import type { Request } from 'express';

import type { FlowNode, FlowTab } from '../runtime/types.js';
import type { Proposal } from '../storage/proposals.js';

import { absolutizePath } from './access-path.js';
import { normalizeHttpAdminRoot } from './auth.js';

/** Max length for a stored/submitted proposal title. */
export const PROPOSAL_TITLE_MAX = 80;

/** Above this many node ops, titles become "N changes in {flow}". */
const MULTI_CHANGE_TITLE_THRESHOLD = 1;

export interface PresentProposalOptions {
  /** Incoming HTTP request — used to absolutize `reviewUrl`. */
  req?: Request;
  /** Node-RED `httpAdminRoot` (affects `/mcp` path prefix). */
  httpAdminRoot?: string;
}

/** Build present options without assigning `undefined` under exactOptionalPropertyTypes. */
export function presentOptionsFor(req: Request, httpAdminRoot?: string): PresentProposalOptions {
  const opts: PresentProposalOptions = { req };
  if (httpAdminRoot !== undefined) {
    opts.httpAdminRoot = httpAdminRoot;
  }
  return opts;
}

export interface PresentedProposal extends Proposal {
  /** Always set on API responses (stored or auto-generated). */
  title: string;
  /**
   * Human flow label when known (never a raw tab id). Empty string if unknown.
   */
  flowLabel: string;
  /**
   * Pending only: true when `expectedRev` does not match the live flows rev.
   * Omitted for decided proposals or when the live rev could not be read.
   */
  baseRevStale?: boolean;
  /**
   * `title · <server local datetime with offset>`, e.g.
   * `Add inject node "tick2" · 16 Oct 01:35 +00:00`.
   * The datetime is **Node-RED server local time** (not the client's TZ).
   */
  displayName: string;
  /**
   * Absolute deep link when the request Host is known
   * (`https://host/mcp#proposal=<id>`); otherwise same as `reviewPath`.
   * Honors `X-Forwarded-*` only when Express `trust proxy` is set.
   */
  reviewUrl: string;
  /** Relative deep link path (`/mcp#proposal=<id>` or under httpAdminRoot). */
  reviewPath: string;
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

function quoteName(name: string): string {
  return `"${name.replace(/"/g, "'")}"`;
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

/** True when the only meaningful change is the display name/label. */
function isRenameOnly(prev: FlowNode, next: FlowNode): boolean {
  const beforeName = nodeLabel(prev);
  const afterName = nodeLabel(next);
  if (!beforeName || !afterName || beforeName === afterName) {
    return false;
  }
  const ignore = new Set(['x', 'y', 'w', 'h', 'g', 'id', 'z', 'name', 'label']);
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (ignore.has(key)) continue;
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      return false;
    }
  }
  return true;
}

function classifyFlowChanges(
  before: Map<string, FlowNode>,
  after: Map<string, FlowNode>
): {
  added: FlowNode[];
  removed: FlowNode[];
  modified: { before: FlowNode; after: FlowNode }[];
} {
  const added: FlowNode[] = [];
  const removed: FlowNode[] = [];
  const modified: { before: FlowNode; after: FlowNode }[] = [];
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
      modified.push({ before: prev, after: node });
    }
  }
  return { added, removed, modified };
}

function describeOneChange(changes: {
  added: FlowNode[];
  removed: FlowNode[];
  modified: { before: FlowNode; after: FlowNode }[];
}): string | undefined {
  const { added, removed, modified } = changes;
  const total = added.length + removed.length + modified.length;
  if (total !== 1) {
    return undefined;
  }
  if (added[0]) {
    const node = added[0];
    const type = node.type || 'node';
    const name = nodeLabel(node);
    return name ? `Add ${type} node ${quoteName(name)}` : `Add ${type} node`;
  }
  if (removed[0]) {
    const node = removed[0];
    const type = node.type || 'node';
    const name = nodeLabel(node);
    return name ? `Remove ${type} node ${quoteName(name)}` : `Remove ${type} node`;
  }
  const pair = modified[0];
  if (!pair) return undefined;
  const type = pair.after.type || pair.before.type || 'node';
  const beforeName = nodeLabel(pair.before);
  const afterName = nodeLabel(pair.after);
  if (isRenameOnly(pair.before, pair.after) && beforeName && afterName) {
    return `Rename ${type} node ${quoteName(beforeName)} → ${quoteName(afterName)}`;
  }
  const name = afterName || beforeName;
  // Match product copy: "Edit template \"html20k\"" (no "node" word).
  return name ? `Edit ${type} ${quoteName(name)}` : `Edit ${type}`;
}

function flowLabelHint(
  afterFlow: Partial<FlowTab> | undefined,
  baseFlow: Partial<FlowTab> | undefined
): string {
  if (typeof afterFlow?.label === 'string' && afterFlow.label.trim()) {
    return afterFlow.label.trim();
  }
  if (typeof baseFlow?.label === 'string' && baseFlow.label.trim()) {
    return baseFlow.label.trim();
  }
  return '';
}

/**
 * Human flow name for UI / audit — never a raw tab id like `tab1`.
 */
export function resolveFlowLabel(proposal: {
  payload?: { flow?: Partial<FlowTab> };
  baseFlow?: Partial<FlowTab>;
  flowLabel?: string;
}): string {
  if (typeof proposal.flowLabel === 'string' && proposal.flowLabel.trim()) {
    return proposal.flowLabel.trim();
  }
  return flowLabelHint(proposal.payload?.flow, proposal.baseFlow);
}

/**
 * Auto-generate a title from the actual node changes.
 * Examples: `Rename debug node "out" → "out (patched)"`, `Add inject node "tick2"`,
 * `Edit template "html20k"`, `3 changes in Test Flow`.
 * Callers should prefer an AI-supplied title via sanitizeProposalTitle.
 */
export function autoGenerateProposalTitle(
  baseFlow: Partial<FlowTab> | undefined,
  afterFlow: Partial<FlowTab>
): string {
  const changes = classifyFlowChanges(collectNodes(baseFlow ?? {}), collectNodes(afterFlow));
  const total = changes.added.length + changes.removed.length + changes.modified.length;
  const label = flowLabelHint(afterFlow, baseFlow);

  if (total === 0) {
    return label ? `Update ${label}` : 'Update flow';
  }

  if (total > MULTI_CHANGE_TITLE_THRESHOLD) {
    return label ? `${total} changes in ${label}` : `${total} changes`;
  }

  return describeOneChange(changes) ?? (label ? `Update ${label}` : 'Update flow');
}

export function buildProposalDisplayName(title: string, createdAtIso: string): string {
  return `${title} · ${formatProposalSubmittedAt(createdAtIso)}`;
}

/** Format numeric timezone offset minutes as `+00:00` / `-05:30`. */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/**
 * Format ISO timestamp in Node-RED **server** local time as
 * `16 Oct 01:35 +00:00` (explicit offset). Callers should treat this as
 * server time; clients with a UI should render `createdAt` in the browser TZ.
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
  // getTimezoneOffset is minutes *behind* UTC; invert for the usual ±HH:MM form.
  const offset = formatUtcOffset(-d.getTimezoneOffset());
  return `${day} ${month} ${hh}:${mm} ${offset}`;
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

/** Relative `/mcp#proposal=<id>` path (respects httpAdminRoot). */
export function buildProposalReviewPath(proposalId: string, httpAdminRoot?: string): string {
  const root = normalizeHttpAdminRoot(httpAdminRoot);
  const base = root === '/' ? '/mcp' : `${root}/mcp`;
  return `${base}#proposal=${encodeURIComponent(proposalId)}`;
}

/**
 * Absolute review URL when request Host is known; otherwise the relative path.
 * @deprecated Prefer `buildProposalReviewPath` + `absolutizePath`, or presentProposal.
 */
export function buildProposalReviewUrl(
  proposalId: string,
  options: PresentProposalOptions = {}
): string {
  const path = buildProposalReviewPath(proposalId, options.httpAdminRoot);
  if (options.req) {
    return absolutizePath(options.req, path);
  }
  return path;
}

/**
 * Resolve the effective title for a proposal (stored/AI title, or auto from changes).
 */
export function resolveProposalTitle(proposal: Proposal): string {
  const stored = sanitizeProposalTitle(proposal.title);
  if (stored) {
    return stored;
  }
  return autoGenerateProposalTitle(proposal.baseFlow, proposal.payload.flow);
}

/** Attach title, flowLabel, displayName, reviewUrl, and reviewPath for API / MCP responses. */
export function presentProposal(
  proposal: Proposal,
  options: PresentProposalOptions = {}
): PresentedProposal {
  const title = resolveProposalTitle(proposal);
  const reviewPath = buildProposalReviewPath(proposal.id, options.httpAdminRoot);
  const reviewUrl = options.req ? absolutizePath(options.req, reviewPath) : reviewPath;
  return {
    ...proposal,
    title,
    flowLabel: resolveFlowLabel(proposal),
    displayName: buildProposalDisplayName(title, proposal.createdAt),
    reviewUrl,
    reviewPath,
  };
}

export function presentProposals(
  proposals: Proposal[],
  options: PresentProposalOptions = {}
): PresentedProposal[] {
  return proposals.map(p => presentProposal(p, options));
}
