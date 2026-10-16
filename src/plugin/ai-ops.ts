/**
 * Shared AI-facing operations used by REST (`/mcp/api/v1`) and MCP (`/mcp/rpc`).
 * Keeps business logic in one place — HTTP and MCP are thin adapters.
 */

import {
  AdapterUnavailableError,
  FlowNotFoundError,
  FlowRevisionConflictError,
  PluginMisconfiguredError,
} from '../runtime/errors.js';
import { normalizeFlowTab } from '../runtime/flows-util.js';
import type { FlowAdapter, FlowTab } from '../runtime/types.js';
import type { AuditLog } from '../storage/audit-log.js';
import { ProposalNotFoundError, type Proposal, type ProposalStore } from '../storage/proposals.js';
import { assertSafeSegment, sanitizeFlowTab } from '../storage/safe.js';
import { MAX_PROPOSAL_JSON_BYTES, StoragePayloadTooLargeError } from '../storage/trusted-write.js';

import { assertKnownNodeTypes, type NodeTypesAdapter } from './node-types.js';
import {
  autoGenerateProposalTitle,
  buildProposalDisplayName,
  presentProposal,
  resolveProposalTitle,
  sanitizeProposalTitle,
  type PresentedProposal,
  type PresentProposalOptions,
} from './proposal-present.js';
import type { AccessLinkAuthInfo } from './types.js';

export { MAX_PROPOSAL_JSON_BYTES };
export type { PresentedProposal, PresentProposalOptions };

export interface SiblingProposalRef {
  id: string;
  title: string;
  displayName: string;
}

export interface SiblingsOnSameRevResult {
  /** Pending siblings from the **same** access link only (ids/titles safe to share). */
  siblingsOnSameRev: SiblingProposalRef[];
  /** Count of pending siblings from other links (ids not exposed). */
  otherLinkSiblingCount: number;
}

/**
 * Other pending proposals on the same flowId + expectedRev.
 * Only same-link proposals are listed; other links increment `otherLinkSiblingCount`.
 */
export function siblingsOnSameRev(
  store: ProposalStore,
  proposal: Proposal
): SiblingsOnSameRevResult {
  const siblingsOnSameRev: SiblingProposalRef[] = [];
  let otherLinkSiblingCount = 0;
  for (const p of store.list()) {
    if (
      p.id === proposal.id ||
      p.status !== 'pending' ||
      p.expectedRev !== proposal.expectedRev ||
      p.payload.flowId !== proposal.payload.flowId
    ) {
      continue;
    }
    if (p.createdBy.linkId === proposal.createdBy.linkId) {
      const title = resolveProposalTitle(p);
      siblingsOnSameRev.push({
        id: p.id,
        title,
        displayName: buildProposalDisplayName(title, p.createdAt),
      });
    } else {
      otherLinkSiblingCount += 1;
    }
  }
  return { siblingsOnSameRev, otherLinkSiblingCount };
}

/** Spread sibling warning fields onto a JSON response (omit empty array / zero count). */
export function siblingWarningFields(result: SiblingsOnSameRevResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (result.siblingsOnSameRev.length > 0) {
    out.siblingsOnSameRev = result.siblingsOnSameRev;
  }
  if (result.otherLinkSiblingCount > 0) {
    out.otherLinkSiblingCount = result.otherLinkSiblingCount;
  }
  if (result.siblingsOnSameRev.length > 0 || result.otherLinkSiblingCount > 0) {
    out.warning = 'Other pending proposals share this flow revision — approve order may conflict.';
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

  if (nodeTypesAdapter) {
    await assertKnownNodeTypes(nodeTypesAdapter, safeFlow);
  }

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
  });

  return presented;
}

export function listMyProposals(
  store: ProposalStore,
  accessLink: AccessLinkAuthInfo,
  presentOptions: PresentProposalOptions = {}
): PresentedProposal[] {
  return store.list({ linkId: accessLink.id }).map(p => presentProposal(p, presentOptions));
}

export function getMyProposal(
  store: ProposalStore,
  accessLink: AccessLinkAuthInfo,
  id: string,
  presentOptions: PresentProposalOptions = {}
): PresentedProposal {
  if (!id) {
    throw new AiOpsValidationError('Missing proposal id', 'missing_proposal_id');
  }
  const proposal = store.get(id);
  if (proposal.createdBy.linkId !== accessLink.id) {
    throw new ProposalNotFoundError(id);
  }
  return presentProposal(proposal, presentOptions);
}

/** Map shared op errors to REST-style `{ statusCode, body }` for HTTP handlers. */
export function aiOpsErrorToHttp(error: unknown): {
  statusCode: number;
  body: {
    error: string;
    code: string;
    expectedRev?: string;
    currentRev?: string;
    matchCount?: number;
    [key: string]: unknown;
  };
} | null {
  if (error instanceof AiOpsValidationError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: error.message,
        code: error.code,
        ...(error.details ?? {}),
      },
    };
  }
  if (error instanceof FlowRevisionConflictError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: error.message,
        code: error.code,
        expectedRev: error.expectedRev,
        currentRev: error.currentRev,
      },
    };
  }
  if (
    error instanceof FlowNotFoundError ||
    error instanceof ProposalNotFoundError ||
    error instanceof StoragePayloadTooLargeError
  ) {
    return {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code },
    };
  }
  if (error instanceof PluginMisconfiguredError || error instanceof AdapterUnavailableError) {
    return {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code },
    };
  }
  return null;
}
