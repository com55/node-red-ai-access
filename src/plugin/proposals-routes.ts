/**
 * Proposal HTTP handlers.
 */

import type { Response } from 'express';

import type { FlowTab } from '../runtime/types.js';
import type { AuditLog } from '../storage/audit-log.js';
import {
  ProposalConcurrentApproveError,
  ProposalNotFoundError,
  ProposalNotPendingError,
  type ProposalStore,
} from '../storage/proposals.js';
import { assertSafeSegment, sanitizeFlowTab } from '../storage/safe.js';

import type { ProposalService } from './proposal-service.js';
import type { AuthenticatedRequest } from './types.js';

function adminActor(req: AuthenticatedRequest) {
  const actor: { kind: 'admin'; username?: string } = { kind: 'admin' };
  if (typeof req.user?.username === 'string') {
    actor.username = req.user.username;
  }
  return actor;
}

export function createProposalHandler(store: ProposalStore, audit: AuditLog) {
  return (req: AuthenticatedRequest, res: Response): void => {
    if (!req.accessLink) {
      res.status(401).json({ error: 'Access link authentication required' });
      return;
    }

    const body = (req.body ?? {}) as {
      type?: unknown;
      expectedRev?: unknown;
      expected_rev?: unknown;
      payload?: unknown;
    };

    const type = body.type;
    const expectedRev =
      typeof body.expectedRev === 'string'
        ? body.expectedRev
        : typeof body.expected_rev === 'string'
          ? body.expected_rev
          : undefined;
    const payload = body.payload;

    if (type !== 'replace_flow') {
      res.status(400).json({ error: "type must be 'replace_flow'" });
      return;
    }
    if (!expectedRev) {
      res.status(400).json({ error: 'expectedRev is required' });
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      res.status(400).json({ error: 'payload must be an object' });
      return;
    }
    const flowId = (payload as { flowId?: unknown }).flowId;
    const flow = (payload as { flow?: unknown }).flow;
    if (typeof flowId !== 'string' || flowId.length === 0) {
      res.status(400).json({ error: 'payload.flowId is required' });
      return;
    }
    if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
      res.status(400).json({ error: 'payload.flow is required' });
      return;
    }

    let safeExpectedRev: string;
    let safeFlowId: string;
    try {
      safeExpectedRev = assertSafeSegment(expectedRev.slice(0, 200), 'expectedRev');
      safeFlowId = assertSafeSegment(flowId.slice(0, 200), 'flowId');
    } catch {
      res.status(400).json({ error: 'expectedRev and payload.flowId must be safe path segments' });
      return;
    }

    const safeFlow = sanitizeFlowTab(flow) as Partial<FlowTab>;

    const createdBy: {
      kind: 'access-link';
      linkId: string;
      label?: string;
    } = {
      kind: 'access-link',
      linkId: req.accessLink.id,
    };
    if (req.accessLink.label !== undefined) {
      createdBy.label = req.accessLink.label;
    }

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

    res.status(201).json(proposal);
  };
}

export function listProposalsHandler(store: ProposalStore) {
  return (req: AuthenticatedRequest, res: Response): void => {
    if (req.accessLink) {
      res.json({ proposals: store.list({ linkId: req.accessLink.id }) });
      return;
    }
    res.json({ proposals: store.list() });
  };
}

export function getProposalHandler(store: ProposalStore) {
  return (req: AuthenticatedRequest, res: Response): void => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'Missing proposal id' });
      return;
    }
    try {
      const proposal = store.get(id);
      if (req.accessLink && proposal.createdBy.linkId !== req.accessLink.id) {
        res.status(404).json({ error: `Proposal '${id}' was not found` });
        return;
      }
      res.json(proposal);
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        res.status(404).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  };
}

export function approveProposalHandler(service: ProposalService) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'Missing proposal id' });
      return;
    }
    try {
      const proposal = await service.approve(id, adminActor(req));
      res.json(proposal);
    } catch (error) {
      if (
        error instanceof ProposalNotFoundError ||
        error instanceof ProposalNotPendingError ||
        error instanceof ProposalConcurrentApproveError
      ) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  };
}

export function rejectProposalHandler(service: ProposalService) {
  return (req: AuthenticatedRequest, res: Response): void => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'Missing proposal id' });
      return;
    }
    const body = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason : 'Rejected by admin';
    try {
      const proposal = service.reject(id, adminActor(req), reason);
      res.json(proposal);
    } catch (error) {
      if (error instanceof ProposalNotFoundError || error instanceof ProposalNotPendingError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  };
}
