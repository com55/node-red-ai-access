/**
 * Self-contained GET access-link surface: `/mcp/a/<token>/…`
 */

import type { Express, Response } from 'express';

import type { AccessLinkStore } from '../access/link-store.js';
import type { FlowAdapter } from '../runtime/types.js';
import type { AuditLog } from '../storage/audit-log.js';
import type { ProposalStore } from '../storage/proposals.js';

import { aiOpsErrorToHttp, getFlow, getMyProposal, listFlows, listMyProposals } from './ai-ops.js';
import { mcpApiBase, mcpRpcPath } from './auth.js';
import { applyDiffFormat, resolveDiffFormat } from './diff-format.js';
import { renderGetLinkDocs } from './get-link/docs.js';
import {
  getLinkDraftAppendHandler,
  getLinkDraftNewHandler,
  getLinkDraftSubmitHandler,
} from './get-link/draft-handlers.js';
import { DraftStore } from './get-link/draft-store.js';
import {
  getLinkNotFoundHandler,
  jsonError,
  requireGetLinkToken,
  setNoStore,
} from './get-link/middleware.js';
import { getLinkProposeHandler } from './get-link/propose-handler.js';
import { queryString } from './get-link/query.js';
import { computeProposalDiff } from './proposal-diff.js';
import { presentOptionsFor } from './proposal-present.js';
import { createAiAccessDualRateLimiters } from './rate-limit.js';
import { buildStatus } from './status.js';
import type { AiAccessSettings, AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

export interface RegisterGetLinkRoutesOptions {
  linkStore: AccessLinkStore;
  proposalStore: ProposalStore;
  auditLog: AuditLog;
  flowAdapter: FlowAdapter;
  draftStore?: DraftStore;
  /** Optional dual rate-limit stack override (tests). */
  rateLimiters?: ReturnType<typeof createAiAccessDualRateLimiters>;
  /** Optional limits from `aiAccess` settings or test overrides. */
  rateLimit?: AiAccessSettings;
}

export function registerGetLinkRoutes(
  RED: NodeRedPluginAPI,
  options: RegisterGetLinkRoutesOptions
): DraftStore {
  const draftStore = options.draftStore ?? new DraftStore();
  const dual =
    options.rateLimiters ??
    createAiAccessDualRateLimiters(options.rateLimit ?? RED.settings.aiAccess);
  const app: Express = RED.httpAdmin;
  const base = '/mcp/a/:token';
  // IP first (always), then token auth, then per-token bucket.
  const gate = [dual.ip, requireGetLinkToken(RED, options.linkStore), dual.token];

  app.get(base, ...gate, (req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    // Do not reflect the path token into the body (CodeQL XSS / sniffing).
    // Docs use relative ./status, ./flows, … scoped to this URL.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const restBase = mcpApiBase(RED.settings.httpAdminRoot);
    const accessLink = req.accessLink;
    if (!accessLink) {
      jsonError(res, 401, 'Access link required', 'access_link_missing');
      return;
    }
    const md = renderGetLinkDocs({
      link: accessLink,
      openapiPath: `${restBase}/openapi.yaml`,
      restApiBase: restBase,
      mcpRpcPath: mcpRpcPath(RED.settings.httpAdminRoot),
    });
    res.status(200).type('text/markdown; charset=utf-8').send(md);
  });

  app.get(`${base}/status`, ...gate, (req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    res.json(buildStatus(RED, req));
  });

  app.get(`${base}/flows`, ...gate, async (_req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    try {
      res.json(await listFlows(options.flowAdapter));
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error);
      if (mapped) {
        res.status(mapped.statusCode).json({
          ...mapped.body,
          hint: 'Retry after the owner fixes the plugin runtime.',
        });
        return;
      }
      jsonError(res, 502, error instanceof Error ? error.message : String(error), 'upstream_error');
    }
  });

  app.get(`${base}/flows/:id`, ...gate, async (req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    const flowId = req.params.id;
    if (typeof flowId !== 'string' || !flowId) {
      jsonError(res, 400, 'Missing flow id', 'missing_flow_id');
      return;
    }
    try {
      res.json(await getFlow(options.flowAdapter, flowId));
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error);
      if (mapped) {
        res.status(mapped.statusCode).json({
          ...mapped.body,
          hint:
            mapped.body.code === 'flow_not_found'
              ? 'Use an id from GET ./flows'
              : 'Call GET …/flows to list valid ids.',
        });
        return;
      }
      jsonError(res, 502, error instanceof Error ? error.message : String(error), 'upstream_error');
    }
  });

  const httpAdminRoot = RED.settings.httpAdminRoot;
  registerGetLinkProposalRoutes(app, base, gate, options, httpAdminRoot);

  app.get(
    `${base}/propose`,
    ...gate,
    getLinkProposeHandler(
      options.proposalStore,
      options.auditLog,
      options.flowAdapter,
      httpAdminRoot
    )
  );

  registerGetLinkDraftRoutes(app, base, gate, draftStore, options, httpAdminRoot);

  // JSON 404 for unmatched /mcp/a/* paths — never echo the token (no HTML "Cannot GET").
  app.use('/mcp/a', getLinkNotFoundHandler());

  return draftStore;
}

type GetLinkGate = (
  ReturnType<typeof requireGetLinkToken> | ReturnType<typeof createAiAccessDualRateLimiters>['ip']
)[];

function registerGetLinkProposalRoutes(
  app: Express,
  base: string,
  gate: GetLinkGate,
  options: RegisterGetLinkRoutesOptions,
  httpAdminRoot?: string
): void {
  app.get(`${base}/proposals`, ...gate, (req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    const link = req.accessLink;
    if (!link) {
      jsonError(res, 401, 'Access link required', 'access_link_missing');
      return;
    }
    res.json({
      proposals: listMyProposals(
        options.proposalStore,
        link,
        presentOptionsFor(req, httpAdminRoot)
      ),
    });
  });

  app.get(`${base}/proposals/:id`, ...gate, (req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    const id = req.params.id;
    const link = req.accessLink;
    if (typeof id !== 'string' || !id) {
      jsonError(res, 400, 'Missing proposal id', 'missing_proposal_id');
      return;
    }
    if (!link) {
      jsonError(res, 401, 'Access link required', 'access_link_missing');
      return;
    }
    try {
      res.json(
        getMyProposal(options.proposalStore, link, id, presentOptionsFor(req, httpAdminRoot))
      );
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error);
      if (mapped) {
        res.status(mapped.statusCode).json({
          ...mapped.body,
          hint: 'List proposals with GET …/proposals.',
        });
        return;
      }
      throw error;
    }
  });

  app.get(
    `${base}/proposals/:id/diff`,
    ...gate,
    async (req: AuthenticatedRequest, res: Response) => {
      setNoStore(res);
      const id = req.params.id;
      const link = req.accessLink;
      if (typeof id !== 'string' || !id) {
        jsonError(res, 400, 'Missing proposal id', 'missing_proposal_id');
        return;
      }
      if (!link) {
        jsonError(res, 401, 'Access link required', 'access_link_missing');
        return;
      }
      try {
        const proposal = getMyProposal(
          options.proposalStore,
          link,
          id,
          presentOptionsFor(req, httpAdminRoot)
        );
        const format = resolveDiffFormat(queryString(req.query, 'format'));
        res.json(applyDiffFormat(await computeProposalDiff(proposal, options.flowAdapter), format));
      } catch (error) {
        const mapped = aiOpsErrorToHttp(error);
        if (mapped) {
          res.status(mapped.statusCode).json(mapped.body);
          return;
        }
        throw error;
      }
    }
  );
}

function registerGetLinkDraftRoutes(
  app: Express,
  base: string,
  gate: GetLinkGate,
  draftStore: DraftStore,
  options: RegisterGetLinkRoutesOptions,
  httpAdminRoot?: string
): void {
  app.get(`${base}/draft/new`, ...gate, getLinkDraftNewHandler(draftStore, options.flowAdapter));
  app.get(`${base}/draft/:draftId/append`, ...gate, getLinkDraftAppendHandler(draftStore));
  app.get(
    `${base}/draft/:draftId/submit`,
    ...gate,
    getLinkDraftSubmitHandler(
      draftStore,
      options.proposalStore,
      options.auditLog,
      options.flowAdapter,
      httpAdminRoot
    )
  );
}
