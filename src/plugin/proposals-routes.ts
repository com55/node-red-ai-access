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
  listPageFields,
  matchesStatusFilter,
  parseListProposalsQuery,
  presentAccessibleProposalForApi,
  submitReplaceFlowProposal,
  withdrawMyProposal,
} from './ai-ops.js';
import { CANONICAL_ERROR_TEXT, channelErrorHint } from './channel-errors.js';
import { applyDiffFormat, resolveDiffFormat } from './diff-format.js';
import type { NodeTypesAdapter } from './node-types.js';
import { autoClosedFields, expireStalePendingProposals } from './proposal-conflicts.js';
import { computeProposalDiff } from './proposal-diff.js';
import {
  resolveIncludeFromQuery,
  presentOptionsFor,
  presentProposal,
  presentProposalForApi,
  presentProposalsForApi,
} from './proposal-present.js';
import type { ProposalService } from './proposal-service.js';
import { sendCaughtRouteError } from './route-errors.js';
import type { AuthenticatedRequest } from './types.js';

/** JSON + nosniff — never put raw exception text in the body (CodeQL XSS). */
function sendSafeJsonError(
  res: Response,
  statusCode: number,
  code: string,
  extras: Record<string, unknown> = {}
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const body: Record<string, unknown> = {
    error: CANONICAL_ERROR_TEXT[code] ?? 'Request failed',
    code,
    ...extras,
  };
  const hint = channelErrorHint(code, 'rest');
  if (hint && typeof body.hint !== 'string') {
    body.hint = hint;
  }
  res.status(statusCode).json(body);
}

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
      const include = resolveIncludeFromQuery(req.query);
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
      // expectedRev matched live at submit — expire any older pending on this flow.
      const autoClosedCount = expireStalePendingProposals(store, proposal.expectedRev, {
        flowId: proposal.payload.flowId,
      });
      const conflicts = findConflictingProposals(store, store.get(proposal.id), req.accessLink.id);
      const warnings = proposal.warnings;
      res.status(201).json({
        ...presentProposalForApi(proposal, { ...presentOpts, include }),
        mine: true,
        ...conflictWarningFields(conflicts),
        ...autoClosedFields(autoClosedCount),
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
    const include = resolveIncludeFromQuery(req.query);
    let listFilter: ReturnType<typeof parseListProposalsQuery>;
    try {
      listFilter = parseListProposalsQuery(req.query);
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error, 'rest');
      if (mapped) {
        res.status(mapped.statusCode).json(mapped.body);
        return;
      }
      sendCaughtRouteError(res, error);
      return;
    }

    const autoClosedCount = liveRev ? expireStalePendingProposals(store, liveRev) : 0;

    const accessLink = req.accessLink;
    if (accessLink) {
      const page = listAccessibleProposals(store, accessLink, presentOpts, listFilter);
      const proposals = page.proposals.map(p => {
        const lean = presentAccessibleProposalForApi(
          store,
          accessLink,
          p,
          { ...presentOpts, include },
          { includeConflicts: false }
        );
        if (lean.status !== 'pending' || liveRev === undefined) {
          return lean;
        }
        return { ...lean, baseRevStale: lean.expectedRev !== liveRev };
      });
      res.json({
        proposals,
        ...listPageFields({ ...page, returned: page.proposals.length }),
        ...autoClosedFields(autoClosedCount),
      });
      return;
    }

    const storeFilter: { flowId?: string } = {};
    if (listFilter.flowId) {
      storeFilter.flowId = listFilter.flowId;
    }
    const all = presentProposalsForApi(
      store.list(storeFilter).filter(p => matchesStatusFilter(p.status, listFilter.status)),
      { ...presentOpts, include }
    );
    const offset = listFilter.offset ?? 0;
    const sliced =
      listFilter.limit !== undefined
        ? all.slice(offset, offset + listFilter.limit)
        : offset > 0
          ? all.slice(offset)
          : all;
    const proposals = sliced.map(p => {
      if (p.status !== 'pending' || liveRev === undefined) {
        return p;
      }
      return { ...p, baseRevStale: p.expectedRev !== liveRev };
    });
    res.json({
      proposals,
      ...listPageFields({
        total: all.length,
        limit: listFilter.limit ?? null,
        offset,
        returned: proposals.length,
      }),
      ...autoClosedFields(autoClosedCount),
    });
  };
}

export function getProposalHandler(
  store: ProposalStore,
  httpAdminRoot?: string,
  adapter?: FlowAdapter
) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'Missing proposal id' });
      return;
    }
    const presentOpts = presentOptionsFor(req, httpAdminRoot);
    const include = resolveIncludeFromQuery(req.query);
    let liveRev: string | undefined;
    if (adapter) {
      try {
        liveRev = (await adapter.getFlows()).rev;
      } catch {
        // Conflicts still work without liveRev; expiry is best-effort.
      }
    }
    try {
      if (req.accessLink) {
        const presented = getAccessibleProposal(store, req.accessLink, id, presentOpts);
        res.json(
          presentAccessibleProposalForApi(
            store,
            req.accessLink,
            presented,
            { ...presentOpts, include },
            { ...(liveRev ? { liveRev } : {}) }
          )
        );
        return;
      }
      if (liveRev) {
        expireStalePendingProposals(store, liveRev);
      }
      res.json(presentProposalForApi(store.get(id), { ...presentOpts, include }));
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        sendSafeJsonError(res, 404, error.code);
        return;
      }
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
        sendSafeJsonError(res, error.statusCode, error.code);
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
        sendSafeJsonError(res, error.statusCode, error.code);
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
    const include = resolveIncludeFromQuery(req.query);
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
        // Rebuild from code only — never echo exception message as HTML-tainted text.
        sendSafeJsonError(res, mapped.statusCode, mapped.body.code);
        return;
      }
      sendSafeJsonError(res, 500, 'internal_error');
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
        sendSafeJsonError(res, 404, error.code);
        return;
      }
      if (
        error instanceof FlowNotFoundError ||
        error instanceof AdapterUnavailableError ||
        error instanceof PluginMisconfiguredError
      ) {
        sendSafeJsonError(res, error.statusCode, error.code);
        return;
      }
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
