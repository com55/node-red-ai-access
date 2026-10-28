/**
 * Shared AI-facing operations used by REST (`/mcp/api/v1`) and MCP (`/mcp/rpc`).
 * Keeps business logic in one place — HTTP and MCP are thin adapters.
 */

import { FlowRevisionConflictError } from '../runtime/errors.js';
import { normalizeFlowTab } from '../runtime/flows-util.js';
import type { FlowAdapter, FlowTab } from '../runtime/types.js';
import type { AuditLog } from '../storage/audit-log.js';
import {
  ProposalNotFoundError,
  ProposalNotOwnedError,
  ProposalNotPendingError,
  proposalOwnerId,
  type Proposal,
  type ProposalDecisionBy,
  type ProposalStatus,
  type ProposalStore,
} from '../storage/proposals.js';
import { assertSafeSegment, sanitizeFlowTab } from '../storage/safe.js';
import { MAX_PROPOSAL_JSON_BYTES, StoragePayloadTooLargeError } from '../storage/trusted-write.js';

import {
  mapErrorForChannel,
  type ChannelErrorMapped,
  type ErrorChannel,
} from './channel-errors.js';
import {
  collectCrossFlowDuplicateIssues,
  collectFullFlowShapeIssues,
  throwValidationIssues,
  validateFlowTab,
} from './flow-validate.js';
import { assertKnownNodeTypes, type NodeTypesAdapter } from './node-types.js';
import {
  autoClosedFields,
  conflictWarningFields,
  expireStalePendingProposals,
  findConflictingProposals,
  type ConflictingProposalRef,
  type ConflictingProposalsResult,
} from './proposal-conflicts.js';
import {
  autoGenerateProposalTitle,
  presentProposal,
  presentProposalForApi,
  sanitizeProposalTitle,
  type PresentedProposal,
  type PresentedProposalApi,
  type PresentProposalApiOptions,
  type PresentProposalOptions,
} from './proposal-present.js';
import type { AccessLinkAuthInfo } from './types.js';

export { MAX_PROPOSAL_JSON_BYTES };
export type { PresentedProposal, PresentProposalOptions };
export type { ConflictingProposalRef, ConflictingProposalsResult };
export { conflictWarningFields, findConflictingProposals };

/** @deprecated Prefer {@link findConflictingProposals} — same-link-only view removed. */
export type SiblingProposalRef = ConflictingProposalRef;
/** @deprecated Prefer {@link ConflictingProposalsResult}. */
export type SiblingsOnSameRevResult = ConflictingProposalsResult;

/**
 * Pending proposals on the same flow (any access link) that may conflict.
 * @deprecated Prefer {@link findConflictingProposals}.
 */
export function siblingsOnSameRev(
  store: ProposalStore,
  proposal: Proposal,
  callerLinkId?: string
): ConflictingProposalsResult {
  return findConflictingProposals(store, proposal, callerLinkId);
}

/** @deprecated Prefer {@link conflictWarningFields}. */
export function siblingWarningFields(result: ConflictingProposalsResult): Record<string, unknown> {
  return conflictWarningFields(result);
}

export { ProposalNotOwnedError };

/** Presented proposal plus ownership flag for the calling access link. */
export type PresentedProposalWithMine = PresentedProposal & { mine: boolean };
export type PresentedProposalApiWithMine = PresentedProposalApi & { mine: boolean };

function isMineProposal(proposal: Proposal, accessLink: AccessLinkAuthInfo): boolean {
  return proposalOwnerId(proposal.createdBy) === accessLink.id;
}

/** Max page size for proposal list endpoints (REST / GET / MCP). */
export const LIST_PROPOSALS_MAX_LIMIT = 200;

export interface ListProposalsFilter {
  /** true → only this access link's proposals; false → only other links' proposals. */
  mine?: boolean;
  /** Filter by proposal status (any of these; multi-value). */
  status?: ProposalStatus[];
  /** Filter by payload.flowId. */
  flowId?: string;
  /** Page size (1…{@link LIST_PROPOSALS_MAX_LIMIT}). Omit to return all matches. */
  limit?: number;
  /** Skip this many filtered results (default 0). */
  offset?: number;
}

export interface ListProposalsPage {
  proposals: PresentedProposalWithMine[];
  /** Count after filters, before limit/offset. */
  total: number;
  /** Effective page size, or `null` when unbounded. */
  limit: number | null;
  offset: number;
}

const PROPOSAL_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'approved',
  'rejected',
  'failed',
  'withdrawn',
  'expired',
  'superseded',
]);

/** True when no status filter is set or `status` is one of the requested values. */
export function matchesStatusFilter(
  status: ProposalStatus,
  wanted: readonly ProposalStatus[] | undefined
): boolean {
  return !wanted || wanted.length === 0 || wanted.includes(status);
}

export function isProposalStatus(value: unknown): value is ProposalStatus {
  return typeof value === 'string' && PROPOSAL_STATUSES.has(value);
}

/** Allowed values per list filter parameter (for `invalid_filter` bodies). */
export const LIST_FILTER_ALLOWED: Readonly<
  Record<'status' | 'limit' | 'offset' | 'mine' | 'flowId', string>
> = {
  status: [...PROPOSAL_STATUSES].join(', '),
  limit: `integer 1–${LIST_PROPOSALS_MAX_LIMIT}`,
  offset: 'integer ≥ 0',
  mine: 'true, false, 1, 0',
  // status also accepts several values: comma-separated or repeated.
  flowId: 'one flow tab id',
};

export type ListFilterParameter = keyof typeof LIST_FILTER_ALLOWED;

/**
 * Build the shared `400 invalid_filter` error for one list parameter.
 * The raw input is deliberately not echoed back (only constant text).
 */
export function invalidFilterError(
  parameter: ListFilterParameter,
  received?: unknown
): AiOpsValidationError {
  const allowed = LIST_FILTER_ALLOWED[parameter];
  // status is multi-valued: an invalid member uses the plain message on every channel.
  const repeated = parameter !== 'status' && Array.isArray(received);
  return new AiOpsValidationError(
    repeated
      ? `Invalid ${parameter} filter: pass it at most once (multiple values are not supported). Allowed: ${allowed}`
      : `Invalid ${parameter} filter. Allowed: ${allowed}`,
    'invalid_filter',
    {
      details: { parameter, allowed, hint: `Pass ${parameter} as ${allowed}, or omit it.` },
    }
  );
}

/**
 * Every list filter is single-valued on every channel: a repeated query
 * parameter (`?status=a&status=b`) is rejected with `invalid_filter`, matching
 * MCP, whose schema only accepts one value.
 */
function singleQueryValue(parameter: ListFilterParameter, raw: unknown): unknown {
  if (Array.isArray(raw)) {
    throw invalidFilterError(parameter, raw);
  }
  return raw;
}

function parseIntegerFilter(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? raw : null;
  }
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return null;
}

/**
 * Parse shared list-query fields from REST/GET `req.query` (or MCP args).
 * Invalid `status`, `limit`, `offset`, or `mine` throws `400 invalid_filter`
 * naming the parameter and allowed values. `limit` over the max is rejected,
 * not clamped. Omit `limit` to return all matches.
 */
function isUnset(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === '';
}

function parseMineFilter(raw: unknown): boolean | undefined {
  if (isUnset(raw)) return undefined;
  if (raw === 'true' || raw === '1' || raw === true) return true;
  if (raw === 'false' || raw === '0' || raw === false) return false;
  throw invalidFilterError('mine', raw);
}

/**
 * `status` is multi-valued on every channel: comma-separated
 * (`pending,superseded`), repeated (`status=a&status=b`), or an array (MCP).
 * Any invalid value in the set → `invalid_filter`.
 */
export function parseStatusFilter(raw: unknown): ProposalStatus[] | undefined {
  if (isUnset(raw)) return undefined;
  const parts = (Array.isArray(raw) ? (raw as unknown[]) : [raw]).flatMap(v =>
    typeof v === 'string' ? v.split(',') : [v]
  );
  const out: ProposalStatus[] = [];
  for (const part of parts) {
    const value = typeof part === 'string' ? part.trim() : part;
    if (value === '') continue;
    if (!isProposalStatus(value)) throw invalidFilterError('status', raw);
    if (!out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

function parseRangeFilter(
  parameter: 'limit' | 'offset',
  raw: unknown,
  min: number,
  max: number
): number | undefined {
  if (isUnset(raw)) return undefined;
  const n = parseIntegerFilter(raw);
  if (n === null || n < min || n > max) throw invalidFilterError(parameter, raw);
  return n;
}

export function parseListProposalsQuery(query: {
  mine?: unknown;
  status?: unknown;
  flowId?: unknown;
  flow_id?: unknown;
  flow?: unknown;
  limit?: unknown;
  offset?: unknown;
}): ListProposalsFilter {
  const filter: ListProposalsFilter = {};
  const mine = parseMineFilter(singleQueryValue('mine', query.mine));
  if (mine !== undefined) {
    filter.mine = mine;
  }
  const status = parseStatusFilter(query.status);
  if (status) {
    filter.status = status;
  }
  const flowRaw = singleQueryValue('flowId', query.flowId ?? query.flow_id ?? query.flow);
  if (typeof flowRaw === 'string' && flowRaw.length > 0) {
    filter.flowId = flowRaw;
  }
  const limit = parseRangeFilter(
    'limit',
    singleQueryValue('limit', query.limit),
    1,
    LIST_PROPOSALS_MAX_LIMIT
  );
  if (limit !== undefined) {
    filter.limit = limit;
  }
  const offset = parseRangeFilter(
    'offset',
    singleQueryValue('offset', query.offset),
    0,
    Number.MAX_SAFE_INTEGER
  );
  if (offset !== undefined) {
    filter.offset = offset;
  }
  return filter;
}

/**
 * Pagination fields shared by every list channel (GET / REST / MCP):
 * `total` (pre-page count), `offset`, `limit` (when set), `hasMore`, and
 * `nextOffset` (only when `hasMore`). Offset-based; there is no cursor.
 */
export function listPageFields(page: {
  total: number;
  limit: number | null;
  offset: number;
  returned: number;
}): { total: number; offset: number; limit?: number; hasMore: boolean; nextOffset?: number } {
  const end = page.offset + page.returned;
  const hasMore = end < page.total;
  return {
    total: page.total,
    offset: page.offset,
    ...(page.limit !== null ? { limit: page.limit } : {}),
    hasMore,
    ...(hasMore ? { nextOffset: end } : {}),
  };
}

function applyListPagination<T>(
  items: T[],
  filter: ListProposalsFilter
): {
  items: T[];
  total: number;
  limit: number | null;
  offset: number;
} {
  const total = items.length;
  const offset = filter.offset !== undefined && filter.offset > 0 ? filter.offset : 0;
  if (filter.limit === undefined) {
    return { items: offset > 0 ? items.slice(offset) : items, total, limit: null, offset };
  }
  const limit = Math.min(Math.max(1, filter.limit), LIST_PROPOSALS_MAX_LIMIT);
  return { items: items.slice(offset, offset + limit), total, limit, offset };
}

/**
 * List proposals visible to an access link. Every token sees **all** proposals;
 * each item is marked `mine: true|false`. `filter.mine: true` limits to own;
 * `filter.mine: false` limits to proposals created by other links.
 * Supports `status`, `flowId`, and `limit`/`offset` pagination (`total` is pre-page).
 */
export function listAccessibleProposals(
  store: ProposalStore,
  accessLink: AccessLinkAuthInfo,
  presentOptions: PresentProposalOptions = {},
  filter: ListProposalsFilter = {}
): ListProposalsPage {
  const linkId = filter.mine === true ? accessLink.id : undefined;
  const storeFilter: { linkId?: string; flowId?: string } = {};
  if (linkId) {
    storeFilter.linkId = linkId;
  }
  if (filter.flowId) {
    storeFilter.flowId = filter.flowId;
  }
  const listed = store
    .list(storeFilter)
    .filter(p => filter.mine !== false || !isMineProposal(p, accessLink))
    .filter(p => matchesStatusFilter(p.status, filter.status));
  const presented = listed.map(p => ({
    ...presentProposal(p, presentOptions),
    mine: isMineProposal(p, accessLink),
  }));
  const page = applyListPagination(presented, filter);
  return {
    proposals: page.items,
    total: page.total,
    limit: page.limit,
    offset: page.offset,
  };
}

/**
 * @deprecated Prefer {@link listAccessibleProposals}. Kept for the MCP tool alias
 * `list_my_proposals`; now returns all proposals with `mine` flags (use filter).
 */
export function listMyProposals(
  store: ProposalStore,
  accessLink: AccessLinkAuthInfo,
  presentOptions: PresentProposalOptions = {},
  filter: ListProposalsFilter = {}
): ListProposalsPage {
  return listAccessibleProposals(store, accessLink, presentOptions, filter);
}

/**
 * Get any proposal by id (all tokens can read). Marks `mine` for the caller.
 */
export function getAccessibleProposal(
  store: ProposalStore,
  accessLink: AccessLinkAuthInfo,
  id: string,
  presentOptions: PresentProposalOptions = {}
): PresentedProposalWithMine {
  if (!id) {
    throw new AiOpsValidationError('Missing proposal id', 'missing_proposal_id');
  }
  const proposal = store.get(id);
  return {
    ...presentProposal(proposal, presentOptions),
    mine: isMineProposal(proposal, accessLink),
  };
}

/**
 * @deprecated Prefer {@link getAccessibleProposal} (no longer 404s for others' proposals).
 */
export function getMyProposal(
  store: ProposalStore,
  accessLink: AccessLinkAuthInfo,
  id: string,
  presentOptions: PresentProposalOptions = {}
): PresentedProposalWithMine {
  return getAccessibleProposal(store, accessLink, id, presentOptions);
}

function accessLinkActor(accessLink: AccessLinkAuthInfo): ProposalDecisionBy {
  const actor: ProposalDecisionBy = { kind: 'access-link', linkId: accessLink.id };
  if (typeof accessLink.label === 'string' && accessLink.label) {
    actor.label = accessLink.label;
  }
  return actor;
}

/**
 * Withdraw a pending proposal owned by this access link. Status becomes
 * `withdrawn` (separate from admin `rejected`).
 */
export function withdrawMyProposal(
  store: ProposalStore,
  audit: AuditLog,
  accessLink: AccessLinkAuthInfo,
  id: string,
  reason: unknown,
  presentOptions: PresentProposalOptions = {}
): PresentedProposalWithMine {
  if (!id) {
    throw new AiOpsValidationError('Missing proposal id', 'missing_proposal_id');
  }
  let proposal: Proposal;
  try {
    proposal = store.get(id);
  } catch (error) {
    if (error instanceof ProposalNotFoundError) throw error;
    throw error;
  }
  if (!isMineProposal(proposal, accessLink)) {
    throw new ProposalNotOwnedError(id);
  }
  if (proposal.status !== 'pending') {
    throw new ProposalNotPendingError(id, proposal.status);
  }
  const cleaned =
    typeof reason === 'string' && reason.trim()
      ? reason.replace(/\0/g, '').trim().slice(0, 2_000)
      : 'Withdrawn by access link';
  const actor = accessLinkActor(accessLink);
  const withdrawn = store.markWithdrawn(id, actor, cleaned);
  const presented = presentProposal(withdrawn, presentOptions);
  const flowLabel = presented.flowLabel || undefined;
  audit.append('proposal.withdrawn', actor, {
    proposalId: withdrawn.id,
    flowId: withdrawn.payload.flowId,
    title: presented.title,
    displayName: presented.displayName,
    reason: cleaned,
    ...(flowLabel ? { flowLabel } : {}),
  });
  return { ...presented, mine: true };
}

/** Attach conflict warning fields for a pending proposal on read/submit. */
export function conflictsForProposal(
  store: ProposalStore,
  proposal: Proposal | PresentedProposal | PresentedProposalApi,
  callerLinkId?: string,
  options: { liveRev?: string } = {}
): Record<string, unknown> {
  // Prefer store record when we only have a presented view.
  let raw: Proposal;
  try {
    raw = store.get(proposal.id);
  } catch {
    return {};
  }
  // Auto-close peers (and self) that can no longer be approved against liveRev.
  if (options.liveRev) {
    expireStalePendingProposals(store, options.liveRev, { flowId: raw.payload.flowId });
    try {
      raw = store.get(proposal.id);
    } catch {
      return {};
    }
  }
  if (raw.status !== 'pending') {
    return {};
  }
  return conflictWarningFields(findConflictingProposals(store, raw, callerLinkId));
}

/** Lean API present + mine (+ optional conflicts for pending). */
export function presentAccessibleProposalForApi(
  store: ProposalStore,
  accessLink: AccessLinkAuthInfo,
  proposal: Proposal | PresentedProposalWithMine,
  apiOptions: PresentProposalApiOptions = {},
  options: { includeConflicts?: boolean; liveRev?: string } = {}
): PresentedProposalApiWithMine & Record<string, unknown> {
  let presented: PresentedProposalWithMine =
    'mine' in proposal
      ? proposal
      : {
          ...presentProposal(proposal, apiOptions),
          mine: isMineProposal(proposal, accessLink),
        };
  // Expire stale before presenting so list/get reflect closed status.
  let autoClosedCount = 0;
  if (options.liveRev) {
    try {
      const flowId = store.get(presented.id).payload.flowId;
      autoClosedCount = expireStalePendingProposals(store, options.liveRev, { flowId });
      const refreshed = store.get(presented.id);
      presented = {
        ...presentProposal(refreshed, apiOptions),
        mine: isMineProposal(refreshed, accessLink),
      };
    } catch {
      // keep presented
    }
  }
  const lean = presentProposalForApi(presented, apiOptions);
  const out: PresentedProposalApiWithMine & Record<string, unknown> = {
    ...lean,
    mine: presented.mine,
    ...autoClosedFields(autoClosedCount),
  };
  if (options.includeConflicts !== false && lean.status === 'pending') {
    // Already expired above when liveRev was set — do not expire again.
    Object.assign(out, conflictsForProposal(store, lean, accessLink.id));
  }
  return out;
}

export class AiOpsValidationError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Extra JSON fields (e.g. matchCount for ambiguous_match). */
  readonly details?: Record<string, unknown>;
  constructor(
    message: string,
    code = 'validation_error',
    options: { statusCode?: number; details?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = 'AiOpsValidationError';
    this.code = code;
    this.statusCode = options.statusCode ?? 400;
    if (options.details) {
      this.details = options.details;
    }
  }
}

export interface ListFlowsResult {
  rev: string;
  flows: unknown[];
}

export interface GetFlowResult {
  rev: string;
  flow: unknown;
}

export async function listFlows(adapter: FlowAdapter): Promise<ListFlowsResult> {
  const snapshot = await adapter.getFlows();
  return { rev: snapshot.rev, flows: snapshot.flows };
}

export async function getFlow(adapter: FlowAdapter, flowId: string): Promise<GetFlowResult> {
  if (!flowId) {
    throw new AiOpsValidationError('Missing flow id', 'missing_flow_id');
  }
  const snapshot = await adapter.getFlow(flowId);
  // Always normalize so REST/MCP match OpenAPI FlowTab (id + type), even when
  // Node-RED or a thin adapter omits `type`.
  return { rev: snapshot.rev, flow: normalizeFlowTab(flowId, snapshot.flow) };
}

export interface SubmitReplaceFlowInput {
  type?: unknown;
  expectedRev?: unknown;
  expected_rev?: unknown;
  payload?: unknown;
  /**
   * Optional node-level ops (set / add / remove / replace_text). When present
   * without `payload.flow`, the server loads the live tab and applies ops in
   * order before creating the proposal.
   */
  nodes?: unknown;
  /** Optional short title (≤80 chars); auto-generated when omitted. */
  title?: unknown;
}

/**
 * Resolve preferred `expectedRev` (camelCase); accept `expected_rev` as alias.
 */
export function resolveExpectedRev(body: SubmitReplaceFlowInput): string | undefined {
  if (typeof body.expectedRev === 'string' && body.expectedRev.length > 0) {
    return body.expectedRev;
  }
  if (typeof body.expected_rev === 'string' && body.expected_rev.length > 0) {
    return body.expected_rev;
  }
  return undefined;
}

/**
 * When the client sends node ops (including replace_text) without a full tab,
 * load the live flow and apply ops in order. Dynamic import avoids a cycle with
 * get-link/flow-patch (which imports AiOpsValidationError from this module).
 */
function assertNodesArrayOrAbsent(payload: Record<string, unknown>, topLevelNodes: unknown): void {
  if ('nodes' in payload && payload.nodes !== undefined && !Array.isArray(payload.nodes)) {
    throw new AiOpsValidationError('payload.nodes must be an array of node ops', 'invalid_nodes');
  }
  if (topLevelNodes !== undefined && !Array.isArray(topLevelNodes)) {
    throw new AiOpsValidationError('nodes must be an array of node ops', 'invalid_nodes');
  }
}

async function materializePayloadFromNodes(
  adapter: FlowAdapter,
  expectedRev: string,
  payload: Record<string, unknown>,
  topLevelNodes: unknown,
  nodeTypesAdapter?: NodeTypesAdapter
): Promise<{ flowId: string; flow: FlowTab }> {
  const { applyFlowNodeOps, interpretPatch } = await import('./get-link/flow-patch.js');
  assertNodesArrayOrAbsent(payload, topLevelNodes);
  const nodes = Array.isArray(payload.nodes)
    ? payload.nodes
    : Array.isArray(topLevelNodes)
      ? topLevelNodes
      : null;
  if (!nodes) {
    throw new AiOpsValidationError('payload.flow is required', 'missing_flow');
  }
  const flowIdRaw = payload.flowId;
  const flowId = typeof flowIdRaw === 'string' ? flowIdRaw : '';
  if (!flowId) {
    throw new AiOpsValidationError('payload.flowId is required', 'missing_flow_id');
  }
  const interpreted = interpretPatch({ nodes, flowId }, flowId);
  if (interpreted.kind !== 'nodes') {
    throw new AiOpsValidationError('payload.nodes must be node ops', 'invalid_patch');
  }
  const patched = await applyFlowNodeOps(adapter, interpreted.flowId, interpreted.ops, {
    expectedRev,
    ...(nodeTypesAdapter ? { nodeTypes: nodeTypesAdapter } : {}),
  });
  if (patched.expectedRev !== expectedRev) {
    throw new FlowRevisionConflictError(expectedRev, patched.expectedRev, 'submit_proposal');
  }
  return { flowId: interpreted.flowId, flow: patched.flow };
}

/** Resolve flowId + flow from a replace_flow payload (full tab or node ops). */
async function resolveReplaceFlowPayload(
  adapter: FlowAdapter,
  expectedRev: string,
  payloadObj: Record<string, unknown>,
  topLevelNodes: unknown,
  nodeTypesAdapter?: NodeTypesAdapter
): Promise<{ flowId: string; flow: object }> {
  let flowId = payloadObj.flowId;
  let flow = payloadObj.flow;
  const needsMaterialize = !flow || typeof flow !== 'object' || Array.isArray(flow);
  if (needsMaterialize) {
    // Prefer a clear invalid_nodes error over missing_flow when nodes is present but wrong type.
    assertNodesArrayOrAbsent(payloadObj, topLevelNodes);
  }
  if (needsMaterialize && (Array.isArray(payloadObj.nodes) || Array.isArray(topLevelNodes))) {
    const materialized = await materializePayloadFromNodes(
      adapter,
      expectedRev,
      payloadObj,
      topLevelNodes,
      nodeTypesAdapter
    );
    flowId = materialized.flowId;
    flow = materialized.flow;
  }
  if (typeof flowId !== 'string' || flowId.length === 0) {
    throw new AiOpsValidationError('payload.flowId is required', 'missing_flow_id');
  }
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
    throw new AiOpsValidationError('payload.flow is required', 'missing_flow');
  }
  return { flowId, flow };
}

function assertSafeRevAndFlowId(
  expectedRev: string,
  flowId: string
): { safeExpectedRev: string; safeFlowId: string } {
  try {
    return {
      safeExpectedRev: assertSafeSegment(expectedRev.slice(0, 200), 'expectedRev'),
      safeFlowId: assertSafeSegment(flowId.slice(0, 200), 'flowId'),
    };
  } catch {
    throw new AiOpsValidationError(
      'expectedRev and payload.flowId must be safe path segments',
      'invalid_path_segment'
    );
  }
}

export async function submitReplaceFlowProposal(
  store: ProposalStore,
  audit: AuditLog,
  accessLink: AccessLinkAuthInfo,
  body: SubmitReplaceFlowInput,
  adapter: FlowAdapter,
  presentOptions: PresentProposalOptions = {},
  nodeTypesAdapter?: NodeTypesAdapter
): Promise<PresentedProposal> {
  const type = body.type;
  const expectedRev = resolveExpectedRev(body);
  const payload = body.payload;

  if (type !== 'replace_flow') {
    throw new AiOpsValidationError("type must be 'replace_flow'", 'invalid_proposal_type');
  }
  if (!expectedRev) {
    throw new AiOpsValidationError(
      'expectedRev is required (top-level field next to type and payload)',
      'missing_expected_rev'
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AiOpsValidationError('payload must be an object', 'invalid_payload');
  }
  const payloadObj = payload as Record<string, unknown>;
  const resolved = await resolveReplaceFlowPayload(
    adapter,
    expectedRev,
    payloadObj,
    body.nodes,
    nodeTypesAdapter
  );
  const { safeExpectedRev, safeFlowId } = assertSafeRevAndFlowId(expectedRev, resolved.flowId);
  const flow = resolved.flow;

  // Reject oversized raw payloads before sanitization (never truncate/drop).
  const rawPayloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (rawPayloadBytes > MAX_PROPOSAL_JSON_BYTES) {
    throw new StoragePayloadTooLargeError(
      'proposal payload',
      rawPayloadBytes,
      MAX_PROPOSAL_JSON_BYTES
    );
  }

  // Shape-check the raw tab before sanitize (sanitize drops non-array nodes silently).
  const rawFlow = flow as Partial<FlowTab>;
  throwValidationIssues(collectFullFlowShapeIssues(rawFlow, safeFlowId));

  const safeFlow = sanitizeFlowTab(flow) as Partial<FlowTab>;

  // Rev before types (stale rev fails without palette lookup).
  const current = await adapter.getFlows();
  if (current.rev !== safeExpectedRev) {
    throw new FlowRevisionConflictError(safeExpectedRev, current.rev, 'submit_proposal');
  }
  throwValidationIssues(collectCrossFlowDuplicateIssues(safeFlow, safeFlowId, current.flows));

  // Snapshot the live tab at expectedRev so later diffs stay stable if the
  // live flow moves (other approvals, editor edits, …).
  const baseSnapshot = await adapter.getFlow(safeFlowId);
  if (baseSnapshot.rev !== safeExpectedRev) {
    throw new FlowRevisionConflictError(safeExpectedRev, baseSnapshot.rev, 'submit_proposal');
  }
  const safeBaseFlow = sanitizeFlowTab(baseSnapshot.flow) as Partial<FlowTab>;

  if (nodeTypesAdapter) {
    await assertKnownNodeTypes(nodeTypesAdapter, safeFlow);
  }

  const { errors: flowErrors, warnings: flowWarnings } = await validateFlowTab(safeFlow, {
    flowId: safeFlowId,
    baseFlow: safeBaseFlow,
    ...(nodeTypesAdapter ? { nodeTypes: nodeTypesAdapter } : {}),
  });
  throwValidationIssues(flowErrors);

  const auditActor: {
    kind: 'access-link';
    linkId: string;
    label?: string;
  } = {
    kind: 'access-link',
    linkId: accessLink.id,
  };
  if (accessLink.label !== undefined) {
    auditActor.label = accessLink.label;
  }
  const createdBy =
    accessLink.oauthClientId && accessLink.oauthUser
      ? { kind: 'oauth' as const, clientId: accessLink.oauthClientId, user: accessLink.oauthUser }
      : auditActor;

  const title =
    sanitizeProposalTitle(body.title) ?? autoGenerateProposalTitle(safeBaseFlow, safeFlow);

  const proposal = store.create({
    type: 'replace_flow',
    expectedRev: safeExpectedRev,
    payload: {
      flowId: safeFlowId,
      flow: safeFlow,
    },
    baseFlow: safeBaseFlow,
    title,
    createdBy,
    ...(flowWarnings.length > 0 ? { warnings: flowWarnings } : {}),
  });

  const presented = presentProposal(proposal, presentOptions);

  const flowLabel = presented.flowLabel || undefined;
  audit.append('proposal.created', auditActor, {
    proposalId: proposal.id,
    flowId: safeFlowId,
    expectedRev: safeExpectedRev,
    title: presented.title,
    displayName: presented.displayName,
    ...(flowLabel ? { flowLabel } : {}),
    ...(flowWarnings.length > 0 ? { warningCount: flowWarnings.length } : {}),
  });

  return presented;
}

/**
 * Map thrown AI-ops errors to HTTP JSON. Prefer {@link mapErrorForChannel} when
 * the caller knows the surface (GET / REST / MCP) so hints match the channel.
 */
export function aiOpsErrorToHttp(
  error: unknown,
  channel: ErrorChannel = 'rest'
): ChannelErrorMapped | null {
  return mapErrorForChannel(error, channel);
}
