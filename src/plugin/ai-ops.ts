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

import type { AccessLinkAuthInfo } from './types.js';

export { MAX_PROPOSAL_JSON_BYTES };

export class AiOpsValidationError extends Error {
  readonly statusCode = 400;
  readonly code: string;
  constructor(message: string, code = 'validation_error') {
    super(message);
    this.name = 'AiOpsValidationError';
    this.code = code;
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

export async function submitReplaceFlowProposal(
  store: ProposalStore,
  audit: AuditLog,
  accessLink: AccessLinkAuthInfo,
  body: SubmitReplaceFlowInput,
  adapter: FlowAdapter
): Promise<Proposal> {
  const type = body.type;
  const expectedRev = resolveExpectedRev(body);
  const payload = body.payload;

  if (type !== 'replace_flow') {
    throw new AiOpsValidationError("type must be 'replace_flow'", 'invalid_proposal_type');
  }
  if (!expectedRev) {
    throw new AiOpsValidationError('expectedRev is required', 'missing_expected_rev');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AiOpsValidationError('payload must be an object', 'invalid_payload');
  }
  const flowId = (payload as { flowId?: unknown }).flowId;
  const flow = (payload as { flow?: unknown }).flow;
  if (typeof flowId !== 'string' || flowId.length === 0) {
    throw new AiOpsValidationError('payload.flowId is required', 'missing_flow_id');
  }
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
    throw new AiOpsValidationError('payload.flow is required', 'missing_flow');
  }

  let safeExpectedRev: string;
  let safeFlowId: string;
  try {
    safeExpectedRev = assertSafeSegment(expectedRev.slice(0, 200), 'expectedRev');
    safeFlowId = assertSafeSegment(flowId.slice(0, 200), 'flowId');
  } catch {
    throw new AiOpsValidationError(
      'expectedRev and payload.flowId must be safe path segments',
      'invalid_path_segment'
    );
  }

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

  const proposal = store.create({
    type: 'replace_flow',
    expectedRev: safeExpectedRev,
    payload: {
      flowId: safeFlowId,
      flow: safeFlow,
    },
    baseFlow: safeBaseFlow,
    createdBy,
  });

  audit.append('proposal.created', createdBy, {
    proposalId: proposal.id,
    flowId: safeFlowId,
    expectedRev: safeExpectedRev,
  });

  return proposal;
}

export function listMyProposals(store: ProposalStore, accessLink: AccessLinkAuthInfo): Proposal[] {
  return store.list({ linkId: accessLink.id });
}

export function getMyProposal(
  store: ProposalStore,
  accessLink: AccessLinkAuthInfo,
  id: string
): Proposal {
  if (!id) {
    throw new AiOpsValidationError('Missing proposal id', 'missing_proposal_id');
  }
  const proposal = store.get(id);
  if (proposal.createdBy.linkId !== accessLink.id) {
    throw new ProposalNotFoundError(id);
  }
  return proposal;
}

/** Map shared op errors to REST-style `{ statusCode, body }` for HTTP handlers. */
export function aiOpsErrorToHttp(error: unknown): {
  statusCode: number;
  body: { error: string; code: string; expectedRev?: string; currentRev?: string };
} | null {
  if (error instanceof AiOpsValidationError) {
    return {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code },
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
