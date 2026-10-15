/**
 * Shared AI-facing operations used by REST (`/mcp/api/v1`) and MCP (`/mcp/rpc`).
 * Keeps business logic in one place — HTTP and MCP are thin adapters.
 */

import { FlowNotFoundError } from '../runtime/errors.js';
import type { FlowAdapter, FlowTab } from '../runtime/types.js';
import type { AuditLog } from '../storage/audit-log.js';
import { ProposalNotFoundError, type Proposal, type ProposalStore } from '../storage/proposals.js';
import { assertSafeSegment, sanitizeFlowTab } from '../storage/safe.js';
import { StoragePayloadTooLargeError } from '../storage/trusted-write.js';

import type { AccessLinkAuthInfo } from './types.js';

export class AiOpsValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'AiOpsValidationError';
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
    throw new AiOpsValidationError('Missing flow id');
  }
  try {
    const snapshot = await adapter.getFlow(flowId);
    return { rev: snapshot.rev, flow: snapshot.flow };
  } catch (error) {
    if (error instanceof FlowNotFoundError) {
      throw error;
    }
    throw error;
  }
}

export interface SubmitReplaceFlowInput {
  type?: unknown;
  expectedRev?: unknown;
  expected_rev?: unknown;
  payload?: unknown;
}

export function submitReplaceFlowProposal(
  store: ProposalStore,
  audit: AuditLog,
  accessLink: AccessLinkAuthInfo,
  body: SubmitReplaceFlowInput
): Proposal {
  const type = body.type;
  const expectedRev =
    typeof body.expectedRev === 'string'
      ? body.expectedRev
      : typeof body.expected_rev === 'string'
        ? body.expected_rev
        : undefined;
  const payload = body.payload;

  if (type !== 'replace_flow') {
    throw new AiOpsValidationError("type must be 'replace_flow'");
  }
  if (!expectedRev) {
    throw new AiOpsValidationError('expectedRev is required');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AiOpsValidationError('payload must be an object');
  }
  const flowId = (payload as { flowId?: unknown }).flowId;
  const flow = (payload as { flow?: unknown }).flow;
  if (typeof flowId !== 'string' || flowId.length === 0) {
    throw new AiOpsValidationError('payload.flowId is required');
  }
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
    throw new AiOpsValidationError('payload.flow is required');
  }

  let safeExpectedRev: string;
  let safeFlowId: string;
  try {
    safeExpectedRev = assertSafeSegment(expectedRev.slice(0, 200), 'expectedRev');
    safeFlowId = assertSafeSegment(flowId.slice(0, 200), 'flowId');
  } catch {
    throw new AiOpsValidationError('expectedRev and payload.flowId must be safe path segments');
  }

  const safeFlow = sanitizeFlowTab(flow) as Partial<FlowTab>;

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

  try {
    const proposal = store.create({
      type: 'replace_flow',
      expectedRev: safeExpectedRev,
      payload: {
        flowId: safeFlowId,
        flow: safeFlow,
      },
      createdBy,
    });

    audit.append('proposal.created', createdBy, {
      proposalId: proposal.id,
      flowId: safeFlowId,
      expectedRev: safeExpectedRev,
    });

    return proposal;
  } catch (error) {
    if (error instanceof StoragePayloadTooLargeError) {
      throw error;
    }
    throw error;
  }
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
    throw new AiOpsValidationError('Missing proposal id');
  }
  try {
    const proposal = store.get(id);
    if (proposal.createdBy.linkId !== accessLink.id) {
      throw new ProposalNotFoundError(id);
    }
    return proposal;
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      throw error;
    }
    throw error;
  }
}

/** Map shared op errors to REST-style `{ statusCode, body }` for HTTP handlers. */
export function aiOpsErrorToHttp(error: unknown): {
  statusCode: number;
  body: { error: string; code?: string };
} | null {
  if (error instanceof AiOpsValidationError) {
    return { statusCode: error.statusCode, body: { error: error.message } };
  }
  if (error instanceof FlowNotFoundError || error instanceof ProposalNotFoundError) {
    return {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code },
    };
  }
  if (error instanceof StoragePayloadTooLargeError) {
    return {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code },
    };
  }
  return null;
}
