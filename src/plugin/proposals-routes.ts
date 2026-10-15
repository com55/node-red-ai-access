/**
 * Proposal HTTP handlers.
 */

import type { Response } from 'express';

import {
  AdapterUnavailableError,
  FlowNotFoundError,
  PluginMisconfiguredError,
} from '../runtime/errors.js';
import type { FlowAdapter } from '../runtime/types.js';
import type { AuditLog } from '../storage/audit-log.js';
import {
  ProposalConcurrentApproveError,
  ProposalNotFoundError,
  ProposalNotPendingError,
  type ProposalStore,
} from '../storage/proposals.js';
import { StoragePayloadTooLargeError } from '../storage/trusted-write.js';

import {
  ACCESS_LINK_INVALID_CODE,
  ACCESS_LINK_INVALID_MESSAGE,
  ACCESS_LINK_WWW_AUTHENTICATE,
} from './access-link-auth.js';
import {
  aiOpsErrorToHttp,
  getMyProposal,
  listMyProposals,
  submitReplaceFlowProposal,
} from './ai-ops.js';
import { computeProposalDiff } from './proposal-diff.js';
import type { ProposalService } from './proposal-service.js';
import type { AuthenticatedRequest } from './types.js';

function adminActor(req: AuthenticatedRequest) {
  const actor: { kind: 'admin'; username?: string } = { kind: 'admin' };
  if (typeof req.user?.username === 'string') {
    actor.username = req.user.username;
  }
  return actor;
}

export function createProposalHandler(store: ProposalStore, audit: AuditLog, adapter: FlowAdapter) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!req.accessLink) {
      res.setHeader('WWW-Authenticate', ACCESS_LINK_WWW_AUTHENTICATE);
      res.status(401).json({ error: ACCESS_LINK_INVALID_MESSAGE, code: ACCESS_LINK_INVALID_CODE });
      return;
    }

    try {
      const proposal = await submitReplaceFlowProposal(
        store,
        audit,
        req.accessLink,
        (req.body ?? {}) as {
          type?: unknown;
          expectedRev?: unknown;
          expected_rev?: unknown;
          payload?: unknown;
        },
        adapter
      );
      res.status(201).json(proposal);
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error);
      if (mapped) {
        res.status(mapped.statusCode).json(mapped.body);
        return;
      }
      throw error;
    }
  };
}

export function listProposalsHandler(store: ProposalStore) {
  return (req: AuthenticatedRequest, res: Response): void => {
    if (req.accessLink) {
      res.json({ proposals: listMyProposals(store, req.accessLink) });
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
      if (req.accessLink) {
        res.json(getMyProposal(store, req.accessLink, id));
        return;
      }
      res.json(store.get(id));
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        res.status(404).json({ error: error.message, code: error.code });
        return;
      }
      const mapped = aiOpsErrorToHttp(error);
      if (mapped) {
        res.status(mapped.statusCode).json(mapped.body);
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
    const body = (req.body ?? {}) as { deploymentType?: unknown };
    const approveOptions: { deploymentType?: 'nodes' | 'flows' | 'full' } = {};
    if (body.deploymentType !== undefined) {
      if (
        body.deploymentType !== 'nodes' &&
        body.deploymentType !== 'flows' &&
        body.deploymentType !== 'full'
      ) {
        res.status(400).json({ error: "deploymentType must be 'nodes', 'flows', or 'full'" });
        return;
      }
      approveOptions.deploymentType = body.deploymentType;
    }
    try {
      const proposal = await service.approve(id, adminActor(req), approveOptions);
      res.json(proposal);
    } catch (error) {
      if (
        error instanceof ProposalNotFoundError ||
        error instanceof ProposalNotPendingError ||
        error instanceof ProposalConcurrentApproveError ||
        error instanceof StoragePayloadTooLargeError
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
      if (
        error instanceof ProposalNotFoundError ||
        error instanceof ProposalNotPendingError ||
        error instanceof StoragePayloadTooLargeError
      ) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  };
}

/**
 * GET /proposals/:id/diff — compare proposal payload to the live flow tab.
 * Requires admin `read` or the owning access link (same as getProposal).
 */
export function getProposalDiffHandler(store: ProposalStore, adapter: FlowAdapter) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'Missing proposal id' });
      return;
    }
    try {
      const proposal = req.accessLink ? getMyProposal(store, req.accessLink, id) : store.get(id);
      const diff = await computeProposalDiff(proposal, adapter);
      res.json(diff);
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        res.status(404).json({ error: error.message, code: error.code });
        return;
      }
      if (
        error instanceof FlowNotFoundError ||
        error instanceof AdapterUnavailableError ||
        error instanceof PluginMisconfiguredError
      ) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      const mapped = aiOpsErrorToHttp(error);
      if (mapped) {
        res.status(mapped.statusCode).json(mapped.body);
        return;
      }
      throw error;
    }
  };
}
