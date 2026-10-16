/**
 * Human-friendly proposal title, displayName, and reviewUrl helpers.
 */

import type { Request } from 'express';

import type { FlowTab } from '../runtime/types.js';
import type { Proposal } from '../storage/proposals.js';

import { absolutizePath } from './access-path.js';
import { normalizeHttpAdminRoot } from './auth.js';

/** Max length for a stored/submitted proposal title. */
export const PROPOSAL_TITLE_MAX = 80;

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
   * `Update Test Flow · 16 Oct 01:35 +00:00`.
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
 * Auto-generate a plain title from the flow label.
 * Examples: `Update Test Flow`, `Update flow` (when no label).
 * Node/tool names are intentionally omitted — owners see those in the diff.
 */
export function autoGenerateProposalTitle(
  baseFlow: Partial<FlowTab> | undefined,
  afterFlow: Partial<FlowTab>
): string {
  const label = flowLabelHint(afterFlow, baseFlow);
  return label ? `Update ${label}` : 'Update flow';
}

export function buildProposalDisplayName(title: string, createdAtIso: string): string {
  return `${title} · ${formatProposalSubmittedAt(createdAtIso)}`;
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
 * Resolve the effective title for a proposal (stored, or auto from base/payload).
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
