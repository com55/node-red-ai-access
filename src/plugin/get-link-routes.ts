/**
 * Self-contained GET access-link surface: `/mcp/a/<token>/…`
 */

import type { Express, Response } from 'express';

import type { AccessLinkStore } from '../access/link-store.js';
import type { FlowAdapter } from '../runtime/types.js';
import type { AuditLog } from '../storage/audit-log.js';
import type { ProposalStore } from '../storage/proposals.js';

import { aiOpsErrorToHttp, getMyProposal, listFlows, listMyProposals } from './ai-ops.js';
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
  getLinkMintNotSupportedHandler,
  getLinkNotFoundHandler,
  jsonError,
  requireGetLinkToken,
  setNoStore,
} from './get-link/middleware.js';
import { getLinkProposeHandler } from './get-link/propose-handler.js';
import { queryString } from './get-link/query.js';
import {
  getFlowOrSummaryHandler,
  getNodeFieldHandler,
  getNodeHandler,
  searchFlowsHandler,
} from './layered-read-routes.js';
import {
  getNodeTypeHandler,
  listNodeTypesHandler,
  searchPaletteHandler,
} from './node-types-routes.js';
import type { CatalogueFetcher, NodeTypesAdapter } from './node-types.js';
import { computeProposalDiff } from './proposal-diff.js';
import {
  parseIncludeQuery,
  presentOptionsFor,
  presentProposalForApi,
  presentProposalsForApi,
} from './proposal-present.js';
import { createAiAccessDualRateLimiters } from './rate-limit.js';
import { buildStatus } from './status.js';
import type { AiAccessSettings, AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

export interface RegisterGetLinkRoutesOptions {
  linkStore: AccessLinkStore;
  proposalStore: ProposalStore;
  auditLog: AuditLog;
  flowAdapter: FlowAdapter;
  nodeTypesAdapter: NodeTypesAdapter;
  catalogueFetcher?: CatalogueFetcher;
  catalogueUrl?: string;
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

  app.get(`${base}/flows/:id`, ...gate, (req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    void getFlowOrSummaryHandler(options.flowAdapter)(req, res);
  });
  app.get(`${base}/nodes/:id`, ...gate, (req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    void getNodeHandler(options.flowAdapter)(req, res);
  });
  app.get(`${base}/nodes/:id/field/:name`, ...gate, (req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    void getNodeFieldHandler(options.flowAdapter)(req, res);
  });
  app.get(`${base}/search`, ...gate, (req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    void searchFlowsHandler(options.flowAdapter)(req, res);
  });

  const nodeTypeOpts = {
    nodeTypes: options.nodeTypesAdapter,
    ...(options.catalogueFetcher ? { catalogueFetcher: options.catalogueFetcher } : {}),
    ...(options.catalogueUrl ? { catalogueUrl: options.catalogueUrl } : {}),
  };
  app.get(`${base}/node-types`, ...gate, (req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    void listNodeTypesHandler(nodeTypeOpts)(req, res);
  });
  app.get(`${base}/node-types/:type`, ...gate, (req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    void getNodeTypeHandler(nodeTypeOpts)(req, res);
  });
  app.get(`${base}/palette/search`, ...gate, (req: AuthenticatedRequest, res: Response) => {
    setNoStore(res);
    void searchPaletteHandler(nodeTypeOpts)(req, res);
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
      httpAdminRoot,
      options.nodeTypesAdapter
    )
  );

  registerGetLinkDraftRoutes(app, base, gate, draftStore, options, httpAdminRoot);

  // GET links never mint tokens — reject any /links path under /mcp/a explicitly
  // (405 JSON) so a half-wired create route cannot appear by accident.
  const rejectMint = getLinkMintNotSupportedHandler();
  app.all(`${base}/links`, rejectMint);
  app.all(`${base}/links/:id`, rejectMint);

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
    const presentOpts = presentOptionsFor(req, httpAdminRoot);
    const include = parseIncludeQuery(req.query.include);
    res.json({
      proposals: presentProposalsForApi(listMyProposals(options.proposalStore, link, presentOpts), {
        ...presentOpts,
        include,
      }),
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
      const presentOpts = presentOptionsFor(req, httpAdminRoot);
      const include = parseIncludeQuery(req.query.include);
      res.json(
        presentProposalForApi(getMyProposal(options.proposalStore, link, id, presentOpts), {
          ...presentOpts,
          include,
        })
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
        const resolved = resolveDiffFormat(queryString(req.query, 'format'));
        if (!resolved.ok) {
          jsonError(
            res,
            400,
            'Invalid diff format',
            'invalid_diff_format',
            'Valid formats: summary, full (default summary).'
          );
          return;
        }
        res.json(
          applyDiffFormat(await computeProposalDiff(proposal, options.flowAdapter), resolved.format)
        );
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
      httpAdminRoot,
      options.nodeTypesAdapter
    )
  );
}
