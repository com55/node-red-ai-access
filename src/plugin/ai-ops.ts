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
  type Proposal,
  type ProposalDecisionBy,
  type ProposalStore,
} from '../storage/proposals.js';
import { assertSafeSegment, sanitizeFlowTab } from '../storage/safe.js';
import { MAX_PROPOSAL_JSON_BYTES, StoragePayloadTooLargeError } from '../storage/trusted-write.js';

import {
  mapErrorForChannel,
  type ChannelErrorMapped,
  type ErrorChannel,
} from './channel-errors.js';
import { throwValidationIssues, validateFlowTab } from './flow-validate.js';
import { assertKnownNodeTypes, type NodeTypesAdapter } from './node-types.js';
import {
  conflictWarningFields,
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
  return proposal.createdBy.linkId === accessLink.id;
}

export interface ListProposalsFilter {
  /** When true, only proposals created by this access link. */
  mine?: boolean;
}

/**
 * List proposals visible to an access link. Every token sees **all** proposals;
 * each item is marked `mine: true|false`. Pass `filter.mine: true` to limit to own.
 */
export function listAccessibleProposals(
  store: ProposalStore,
  accessLink: AccessLinkAuthInfo,
  presentOptions: PresentProposalOptions = {},
  filter: ListProposalsFilter = {}
): PresentedProposalWithMine[] {
  const linkId = filter.mine === true ? accessLink.id : undefined;
  return store.list(linkId ? { linkId } : undefined).map(p => ({
    ...presentProposal(p, presentOptions),
    mine: isMineProposal(p, accessLink),
  }));
}

/**
 * @deprecated Prefer {@link listAccessibleProposals}. Kept as the MCP tool name
 * `list_my_proposals`; now returns all proposals with `mine` flags (use filter).
 */
export function listMyProposals(
  store: ProposalStore,
  accessLink: AccessLinkAuthInfo,
  presentOptions: PresentProposalOptions = {},
  filter: ListProposalsFilter = {}
): PresentedProposalWithMine[] {
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
  callerLinkId?: string
): Record<string, unknown> {
  if (proposal.status !== 'pending') {
    return {};
  }
  // Prefer store record when we only have a presented view.
  let raw: Proposal;
  try {
    raw = store.get(proposal.id);
  } catch {
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
  options: { includeConflicts?: boolean } = {}
): PresentedProposalApiWithMine & Record<string, unknown> {
  const presented =
    'mine' in proposal
      ? proposal
      : {
          ...presentProposal(proposal, apiOptions),
          mine: isMineProposal(proposal, accessLink),
        };
  const lean = presentProposalForApi(presented, apiOptions);
  const out: PresentedProposalApiWithMine & Record<string, unknown> = {
    ...lean,
    mine: presented.mine,
  };
  if (options.includeConflicts !== false && lean.status === 'pending') {
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
async function materializePayloadFromNodes(
  adapter: FlowAdapter,
  expectedRev: string,
  payload: Record<string, unknown>,
  topLevelNodes: unknown,
  nodeTypesAdapter?: NodeTypesAdapter
): Promise<{ flowId: string; flow: FlowTab }> {
  const { applyFlowNodeOps, interpretPatch } = await import('./get-link/flow-patch.js');
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
  if (
    (!flow || typeof flow !== 'object' || Array.isArray(flow)) &&
    (Array.isArray(payloadObj.nodes) || Array.isArray(topLevelNodes))
  ) {
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

  const safeFlow = sanitizeFlowTab(flow) as Partial<FlowTab>;

  // Rev before types (stale rev fails without palette lookup).
  const current = await adapter.getFlows();
  if (current.rev !== safeExpectedRev) {
    throw new FlowRevisionConflictError(safeExpectedRev, current.rev, 'submit_proposal');
  }

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
    ...(nodeTypesAdapter ? { nodeTypes: nodeTypesAdapter } : {}),
  });
  throwValidationIssues(flowErrors);

  const createdBy: {
    kind: 'access-link';
    linkId: string;
    label?: string;
  } = {
    kind: 'access-link',
    linkId: accessLink.id,
  };
  if (accessLink.label !== undefined) {
    createdBy.label = accessLink.label;
  }

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
  audit.append('proposal.created', createdBy, {
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
