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
  /**
   * Live tab id → label map (from GET flows). Used when the stored proposal
   * snapshot omitted a label so oldest cards still resolve a flow name.
   */
  liveFlowLabels?: Map<string, string>;
}

/** Options for lean API presentation (`?include=payload,baseFlow`). */
export interface PresentProposalApiOptions extends PresentProposalOptions {
  /** Comma-parsed include set — currently `payload` and/or `baseFlow`. */
  include?: Set<string>;
}

/** Lean proposal shape returned by default from create/get/list/propose. */
export interface PresentedProposalApi {
  id: string;
  status: Proposal['status'];
  type: Proposal['type'];
  title: string;
  displayName: string;
  flowLabel: string;
  reviewUrl: string;
  reviewPath: string;
  createdAt: string;
  updatedAt: string;
  expectedRev: string;
  createdBy: Proposal['createdBy'];
  /** Short classify-counts summary, e.g. `Adds 1 node`. */
  changeSummary: string;
  payload?: Proposal['payload'];
  baseFlow?: Proposal['baseFlow'];
  baseRevStale?: boolean;
  decidedBy?: Proposal['decidedBy'];
  reason?: string;
  resultRev?: string;
}

/** Parse `?include=payload,baseFlow` (comma-separated, case-sensitive keys). */
export function parseIncludeQuery(raw: unknown): Set<string> {
  if (typeof raw !== 'string' || !raw.trim()) {
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
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

function pluralNodes(n: number): string {
  return n === 1 ? 'node' : 'nodes';
}

/** "adds 1 comment" / "adds 2 nodes" */
function describeAddedClause(added: FlowNode[]): string {
  if (added.length === 1 && added[0]) {
    const type = added[0].type || 'node';
    return `adds 1 ${type}`;
  }
  return `adds ${added.length} ${pluralNodes(added.length)}`;
}

function describeRemovedClause(removed: number): string {
  return `deletes ${removed} ${pluralNodes(removed)}`;
}

function describeModifiedClause(modified: number): string {
  return `edits ${modified} ${pluralNodes(modified)}`;
}

/**
 * When any nodes are deleted, lead with that
 * (`Replace Test Flow: deletes 4 nodes, adds 1 comment`).
 */
export function buildReplaceFlowTitle(options: {
  flowLabel?: string;
  removed: number;
  added?: FlowNode[];
  addedCount?: number;
  modified?: number;
}): string {
  const parts: string[] = [];
  if (options.removed > 0) {
    parts.push(describeRemovedClause(options.removed));
  }
  const addedNodes = options.added ?? [];
  const addedCount = options.addedCount ?? addedNodes.length;
  if (addedCount > 0) {
    parts.push(
      addedNodes.length === addedCount
        ? describeAddedClause(addedNodes)
        : `adds ${addedCount} ${pluralNodes(addedCount)}`
    );
  }
  if ((options.modified ?? 0) > 0) {
    parts.push(describeModifiedClause(options.modified ?? 0));
  }
  const detail = parts.length ? parts.join(', ') : 'replaces nodes';
  const label = options.flowLabel?.trim();
  return label ? `Replace ${label}: ${detail}` : `Replace flow: ${detail}`;
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
export function resolveFlowLabel(
  proposal: {
    payload?: { flowId?: string; flow?: Partial<FlowTab> };
    baseFlow?: Partial<FlowTab>;
    flowLabel?: string;
  },
  liveFlowLabels?: Map<string, string>
): string {
  if (typeof proposal.flowLabel === 'string' && proposal.flowLabel.trim()) {
    return proposal.flowLabel.trim();
  }
  const fromFlows = flowLabelHint(proposal.payload?.flow, proposal.baseFlow);
  if (fromFlows) {
    return fromFlows;
  }
  const flowId = proposal.payload?.flowId;
  if (flowId && liveFlowLabels?.has(flowId)) {
    return liveFlowLabels.get(flowId) ?? '';
  }
  return '';
}

/** Append ` in {flow}` when the title does not already mention the flow name. */
export function ensureTitleIncludesFlowName(title: string, flowLabel: string): string {
  const label = flowLabel.trim();
  const t = title.trim();
  if (!label || !t) {
    return t;
  }
  if (t.includes(label)) {
    return t;
  }
  return `${t} in ${label}`;
}

/**
 * Auto-generate a title from the actual node changes.
 * Examples: `Rename debug node "out" → "out (patched)"`, `Add inject node "tick2"`,
 * `Edit template "html20k"`, `Replace Test Flow: deletes 4 nodes, adds 1 comment`.
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

  // Deletions always lead — never bury them under a lone "Add …" title.
  if (changes.removed.length > 0) {
    return buildReplaceFlowTitle({
      ...(label ? { flowLabel: label } : {}),
      removed: changes.removed.length,
      added: changes.added,
      modified: changes.modified.length,
    });
  }

  if (total > MULTI_CHANGE_TITLE_THRESHOLD) {
    return label ? `${total} changes in ${label}` : `${total} changes`;
  }

  const one = describeOneChange(changes) ?? (label ? `Update ${label}` : 'Update flow');
  return ensureTitleIncludesFlowName(one, label);
}

/** True for titles we should refresh from a live diff (legacy / auto / non-replace deletes). */
export function shouldRefreshDisplayTitle(
  storedTitle: string | undefined,
  removedCount: number
): boolean {
  const t = (storedTitle ?? '').trim();
  if (!t) return true;
  if (/^Update(\s|$)/i.test(t)) return true;
  if (removedCount > 0 && !/^Replace\b/i.test(t)) return true;
  return false;
}

/**
 * Build a display title from a proposal-diff summary (client or server).
 * Prefer AI-supplied titles unless {@link shouldRefreshDisplayTitle} says otherwise.
 */
export function titleFromDiffSummary(
  summary: {
    added?: number;
    removed?: number;
    modified?: number;
  },
  options: {
    flowLabel?: string;
    storedTitle?: string;
    /** First added node type for "adds 1 comment" wording. */
    firstAddedType?: string;
  } = {}
): string {
  const removed = Number(summary.removed) || 0;
  const added = Number(summary.added) || 0;
  const modified = Number(summary.modified) || 0;
  const stored = options.storedTitle?.trim() ?? '';
  if (!shouldRefreshDisplayTitle(stored, removed)) {
    return stored;
  }
  const label = options.flowLabel?.trim() ?? '';
  if (removed > 0) {
    const addedNodes: FlowNode[] =
      added === 1 && options.firstAddedType ? [{ id: '_', type: options.firstAddedType }] : [];
    return buildReplaceFlowTitle({
      ...(label ? { flowLabel: label } : {}),
      removed,
      added: addedNodes,
      addedCount: added,
      modified,
    });
  }
  const total = added + modified;
  if (total === 0) {
    return label ? `Update ${label}` : 'Update flow';
  }
  if (total === 1 && added === 1 && options.firstAddedType) {
    return ensureTitleIncludesFlowName(`Add ${options.firstAddedType} node`, label);
  }
  if (total === 1 && modified === 1) {
    return label ? `Edit node in ${label}` : 'Edit node';
  }
  return label ? `${total} changes in ${label}` : `${total} changes`;
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
 * Legacy "Update …" titles and non-Replace titles that delete nodes are refreshed
 * from the flow diff so display stays accurate even when the stored title is stale.
 */
export function resolveProposalTitle(
  proposal: Proposal,
  options: PresentProposalOptions = {}
): string {
  const flowLabel = resolveFlowLabel(proposal, options.liveFlowLabels);
  const stored = sanitizeProposalTitle(proposal.title);
  const auto = autoGenerateProposalTitle(
    proposal.baseFlow,
    flowLabel && !flowLabelHint(proposal.payload.flow, proposal.baseFlow)
      ? { ...proposal.payload.flow, label: flowLabel }
      : proposal.payload.flow
  );
  const changes = classifyFlowChanges(
    collectNodes(proposal.baseFlow ?? {}),
    collectNodes(proposal.payload.flow)
  );
  const raw = shouldRefreshDisplayTitle(stored, changes.removed.length) ? auto : (stored ?? auto);
  return ensureTitleIncludesFlowName(raw, flowLabel);
}

/** Attach title, flowLabel, displayName, reviewUrl, and reviewPath for API / MCP responses. */
export function presentProposal(
  proposal: Proposal,
  options: PresentProposalOptions = {}
): PresentedProposal {
  const title = resolveProposalTitle(proposal, options);
  const flowLabel = resolveFlowLabel(proposal, options.liveFlowLabels);
  const reviewPath = buildProposalReviewPath(proposal.id, options.httpAdminRoot);
  const reviewUrl = options.req ? absolutizePath(options.req, reviewPath) : reviewPath;
  return {
    ...proposal,
    title,
    flowLabel,
    displayName: buildProposalDisplayName(title, proposal.createdAt),
    reviewUrl,
    reviewPath,
  };
}

/**
 * Short change summary from classify counts (not the full auto title).
 * Examples: `Adds 1 node`, `Edits 2 nodes`, `Deletes 1 node, adds 1 node`.
 */
export function buildChangeSummary(proposal: Proposal): string {
  const changes = classifyFlowChanges(
    collectNodes(proposal.baseFlow ?? {}),
    collectNodes(proposal.payload.flow)
  );
  const parts: string[] = [];
  if (changes.added.length > 0) {
    parts.push(changes.added.length === 1 ? 'Adds 1 node' : `Adds ${changes.added.length} nodes`);
  }
  if (changes.removed.length > 0) {
    parts.push(
      changes.removed.length === 1 ? 'Deletes 1 node' : `Deletes ${changes.removed.length} nodes`
    );
  }
  if (changes.modified.length > 0) {
    parts.push(
      changes.modified.length === 1 ? 'Edits 1 node' : `Edits ${changes.modified.length} nodes`
    );
  }
  if (parts.length === 0) {
    return 'No node changes';
  }
  // Capitalize only the first clause; join the rest in lowercase style of titles.
  return parts.map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1))).join(', ');
}

/** Redact createdBy for API when only kind/label are needed (omit empty label). */
function presentCreatedByForApi(createdBy: Proposal['createdBy']): Proposal['createdBy'] {
  const out: Proposal['createdBy'] = {
    kind: createdBy.kind,
    linkId: createdBy.linkId,
  };
  if (typeof createdBy.label === 'string' && createdBy.label.length > 0) {
    out.label = createdBy.label;
  }
  return out;
}

/**
 * Lean API presentation: omits full `payload` / `baseFlow` unless
 * `options.include` contains those keys. Prefer for create/get/list/propose.
 * Use {@link presentProposal} when the full bodies are needed internally.
 */
export function presentProposalForApi(
  proposal: Proposal,
  options: PresentProposalApiOptions = {}
): PresentedProposalApi {
  const full = presentProposal(proposal, options);
  const include = options.include ?? new Set<string>();
  const lean: PresentedProposalApi = {
    id: full.id,
    status: full.status,
    type: full.type,
    title: full.title,
    displayName: full.displayName,
    flowLabel: full.flowLabel,
    reviewUrl: full.reviewUrl,
    reviewPath: full.reviewPath,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
    expectedRev: full.expectedRev,
    createdBy: presentCreatedByForApi(full.createdBy),
    changeSummary: buildChangeSummary(proposal),
  };
  if (include.has('payload')) {
    lean.payload = full.payload;
  }
  if (include.has('baseFlow') && full.baseFlow !== undefined) {
    lean.baseFlow = full.baseFlow;
  }
  if (full.baseRevStale !== undefined) {
    lean.baseRevStale = full.baseRevStale;
  }
  if (full.decidedBy !== undefined) {
    lean.decidedBy = full.decidedBy;
  }
  if (full.reason !== undefined) {
    lean.reason = full.reason;
  }
  if (full.resultRev !== undefined) {
    lean.resultRev = full.resultRev;
  }
  return lean;
}

export function presentProposals(
  proposals: Proposal[],
  options: PresentProposalOptions = {}
): PresentedProposal[] {
  return proposals.map(p => presentProposal(p, options));
}

export function presentProposalsForApi(
  proposals: Proposal[],
  options: PresentProposalApiOptions = {}
): PresentedProposalApi[] {
  return proposals.map(p => presentProposalForApi(p, options));
}
