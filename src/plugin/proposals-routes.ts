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
  ACCESS_LINK_MISSING_CODE,
  ACCESS_LINK_MISSING_MESSAGE,
  ACCESS_LINK_WWW_AUTHENTICATE,
} from './access-link-auth.js';
import {
  aiOpsErrorToHttp,
  conflictWarningFields,
  findConflictingProposals,
  getAccessibleProposal,
  listAccessibleProposals,
  presentAccessibleProposalForApi,
  submitReplaceFlowProposal,
  withdrawMyProposal,
} from './ai-ops.js';
import { applyDiffFormat, resolveDiffFormat } from './diff-format.js';
import type { NodeTypesAdapter } from './node-types.js';
import { computeProposalDiff } from './proposal-diff.js';
import {
  parseIncludeQuery,
  presentOptionsFor,
  presentProposal,
  presentProposalForApi,
  presentProposalsForApi,
} from './proposal-present.js';
import type { ProposalService } from './proposal-service.js';
import { sendCaughtRouteError } from './route-errors.js';
import type { AuthenticatedRequest } from './types.js';

function adminActor(req: AuthenticatedRequest) {
  const actor: { kind: 'admin'; username?: string } = { kind: 'admin' };
  if (typeof req.user?.username === 'string') {
    actor.username = req.user.username;
  }
  return actor;
}

export function createProposalHandler(
  store: ProposalStore,
  audit: AuditLog,
  adapter: FlowAdapter,
  httpAdminRoot?: string,
  nodeTypesAdapter?: NodeTypesAdapter
) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!req.accessLink) {
      res.setHeader('WWW-Authenticate', ACCESS_LINK_WWW_AUTHENTICATE);
      res.status(401).json({
        error: ACCESS_LINK_MISSING_MESSAGE,
        code: ACCESS_LINK_MISSING_CODE,
      });
      return;
    }

    try {
      const presentOpts = presentOptionsFor(req, httpAdminRoot);
      const include = parseIncludeQuery(req.query.include);
      const proposal = await submitReplaceFlowProposal(
        store,
        audit,
        req.accessLink,
        (req.body ?? {}) as {
          type?: unknown;
          expectedRev?: unknown;
          expected_rev?: unknown;
          payload?: unknown;
          title?: unknown;
        },
        adapter,
        presentOpts,
        nodeTypesAdapter
      );
      const conflicts = findConflictingProposals(store, store.get(proposal.id), req.accessLink.id);
      const warnings = proposal.warnings;
      res.status(201).json({
        ...presentProposalForApi(proposal, { ...presentOpts, include }),
        mine: true,
        ...conflictWarningFields(conflicts),
        ...(warnings && warnings.length > 0 ? { warnings } : {}),
      });
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error, 'rest');
      if (mapped) {
        res.status(mapped.statusCode).json(mapped.body);
        return;
      }
      sendCaughtRouteError(res, error);
      return;
    }
  };
}

function liveFlowLabelsFromSnapshot(
  flows: { id: string; type?: string; label?: unknown }[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of flows) {
    if (node.type === 'tab' && typeof node.label === 'string' && node.label.trim()) {
      map.set(node.id, node.label.trim());
    }
  }
  return map;
}

export function listProposalsHandler(
  store: ProposalStore,
  adapter: FlowAdapter,
  httpAdminRoot?: string
) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    let liveRev: string | undefined;
    let liveFlowLabels: Map<string, string> | undefined;
    try {
      const snapshot = await adapter.getFlows();
      liveRev = snapshot.rev;
      liveFlowLabels = liveFlowLabelsFromSnapshot(snapshot.flows);
    } catch {
      // Client can still learn stale from /diff when live rev is unavailable.
    }

    const presentOpts = {
      ...presentOptionsFor(req, httpAdminRoot),
      ...(liveFlowLabels ? { liveFlowLabels } : {}),
    };
    const include = parseIncludeQuery(req.query.include);
    const mineOnly = req.query.mine === 'true' || req.query.mine === '1';

    const accessLink = req.accessLink;
    if (accessLink) {
      const list = listAccessibleProposals(store, accessLink, presentOpts, {
        ...(mineOnly ? { mine: true } : {}),
      });
      const proposals = list.map(p => {
        const lean = presentAccessibleProposalForApi(store, accessLink, p, {
          ...presentOpts,
          include,
        });
        if (lean.status !== 'pending' || liveRev === undefined) {
          return lean;
        }
        return { ...lean, baseRevStale: lean.expectedRev !== liveRev };
      });
      res.json({ proposals });
      return;
    }

    const proposals = presentProposalsForApi(store.list(), { ...presentOpts, include }).map(p => {
      if (p.status !== 'pending' || liveRev === undefined) {
        return p;
      }
      return { ...p, baseRevStale: p.expectedRev !== liveRev };
    });
    res.json({ proposals });
  };
}

export function getProposalHandler(store: ProposalStore, httpAdminRoot?: string) {
  return (req: AuthenticatedRequest, res: Response): void => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'Missing proposal id' });
      return;
    }
    const presentOpts = presentOptionsFor(req, httpAdminRoot);
    const include = parseIncludeQuery(req.query.include);
    try {
      if (req.accessLink) {
        const presented = getAccessibleProposal(store, req.accessLink, id, presentOpts);
        res.json(
          presentAccessibleProposalForApi(store, req.accessLink, presented, {
            ...presentOpts,
            include,
          })
        );
        return;
      }
      res.json(presentProposalForApi(store.get(id), { ...presentOpts, include }));
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
      sendCaughtRouteError(res, error);
      return;
    }
  };
}

export function approveProposalHandler(service: ProposalService, httpAdminRoot?: string) {
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
      res.json(presentProposal(proposal, presentOptionsFor(req, httpAdminRoot)));
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
      sendCaughtRouteError(res, error);
      return;
    }
  };
}

export function rejectProposalHandler(service: ProposalService, httpAdminRoot?: string) {
  return (req: AuthenticatedRequest, res: Response): void => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'Missing proposal id' });
      return;
    }
    const body = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason : 'Rejected by admin';
    try {
      const proposal = presentProposal(
        service.reject(id, adminActor(req), reason),
        presentOptionsFor(req, httpAdminRoot)
      );
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
      sendCaughtRouteError(res, error);
      return;
    }
  };
}

/**
 * POST /proposals/:id/withdraw — access-link only; withdraw own pending proposal.
 */
export function withdrawProposalHandler(
  store: ProposalStore,
  audit: AuditLog,
  httpAdminRoot?: string
) {
  return (req: AuthenticatedRequest, res: Response): void => {
    if (!req.accessLink) {
      res.setHeader('WWW-Authenticate', ACCESS_LINK_WWW_AUTHENTICATE);
      res.status(401).json({
        error: ACCESS_LINK_MISSING_MESSAGE,
        code: ACCESS_LINK_MISSING_CODE,
      });
      return;
    }
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'Missing proposal id', code: 'missing_proposal_id' });
      return;
    }
    const body = (req.body ?? {}) as { reason?: unknown };
    const presentOpts = presentOptionsFor(req, httpAdminRoot);
    const include = parseIncludeQuery(req.query.include);
    try {
      const withdrawn = withdrawMyProposal(
        store,
        audit,
        req.accessLink,
        id,
        body.reason,
        presentOpts
      );
      res.json(
        presentAccessibleProposalForApi(store, req.accessLink, withdrawn, {
          ...presentOpts,
          include,
        })
      );
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error, 'rest');
      if (mapped) {
        res.status(mapped.statusCode).json(mapped.body);
        return;
      }
      sendCaughtRouteError(res, error);
      return;
    }
  };
}

/**
 * GET /proposals/:id/diff — compare proposal payload to its stored baseFlow
 * snapshot (what the AI changed). Pending + stale also includes `vsCurrent`.
 * Requires admin `read` or any access link (all proposals are readable).
 */
export function getProposalDiffHandler(store: ProposalStore, adapter: FlowAdapter) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'Missing proposal id' });
      return;
    }
    try {
      const proposal = req.accessLink
        ? getAccessibleProposal(store, req.accessLink, id)
        : store.get(id);
      const resolved = resolveDiffFormat(req.query.format);
      if (!resolved.ok) {
        res.status(400).json({
          error: 'Invalid diff format',
          code: 'invalid_diff_format',
          hint: 'Valid formats: summary, full (default summary).',
        });
        return;
      }
      const diff = applyDiffFormat(await computeProposalDiff(proposal, adapter), resolved.format);
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
      sendCaughtRouteError(res, error);
      return;
    }
  };
}
