/**
 * Self-contained GET access-link surface: `/mcp/a/<token>/…`
 */

import type { Express, Response } from 'express';

import type { AccessLinkStore } from '../access/link-store.js';
import type { FlowAdapter } from '../runtime/types.js';
import type { AuditLog } from '../storage/audit-log.js';
import type { ProposalStore } from '../storage/proposals.js';

import { getConfiguredPublicBaseUrl } from './access-path.js';
import {
  aiOpsErrorToHttp,
  getAccessibleProposal,
  listAccessibleProposals,
  listPageFields,
  listFlows,
  parseListProposalsQuery,
  presentAccessibleProposalForApi,
  withdrawMyProposal,
} from './ai-ops.js';
import { mcpApiBase, mcpRpcPath } from './auth.js';
import { CANONICAL_ERROR_TEXT, channelErrorHint } from './channel-errors.js';
import { getLinkContentNegotiation } from './content-type.js';
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
import { autoClosedFields, expireStalePendingProposals } from './proposal-conflicts.js';
import { computeProposalDiff } from './proposal-diff.js';
import { resolveIncludeFromQuery, presentOptionsFor } from './proposal-present.js';
import { createAiAccessDualRateLimiters } from './rate-limit.js';
import { asyncRoute, sendCaughtRouteError } from './route-errors.js';
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

  // Every response under /mcp/a defaults to text/plain (markdown + JSON bodies
  // unchanged); `Accept` or `?format=md|json` opts in to the real type.
  app.use('/mcp/a', getLinkContentNegotiation());

  app.get(
    base,
    ...gate,
    asyncRoute((req: AuthenticatedRequest, res: Response) => {
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
        publicBaseUrl: getConfiguredPublicBaseUrl(),
      });
      res.status(200).type('text/markdown; charset=utf-8').send(md);
    })
  );

  app.get(
    `${base}/status`,
    ...gate,
    asyncRoute((req: AuthenticatedRequest, res: Response) => {
      setNoStore(res);
      res.json(buildStatus(RED, req));
    })
  );

  app.get(
    `${base}/flows`,
    ...gate,
    asyncRoute(async (_req: AuthenticatedRequest, res: Response) => {
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
        jsonError(
          res,
          502,
          error instanceof Error ? error.message : String(error),
          'upstream_error'
        );
      }
    })
  );

  app.get(
    `${base}/flows/:id`,
    ...gate,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      setNoStore(res);
      await getFlowOrSummaryHandler(options.flowAdapter, 'get')(req, res);
    })
  );
  app.get(
    `${base}/nodes/:id`,
    ...gate,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      setNoStore(res);
      await getNodeHandler(options.flowAdapter, 'get')(req, res);
    })
  );
  app.get(
    `${base}/nodes/:id/field/:name`,
    ...gate,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      setNoStore(res);
      await getNodeFieldHandler(options.flowAdapter, 'get')(req, res);
    })
  );
  app.get(
    `${base}/search`,
    ...gate,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      setNoStore(res);
      await searchFlowsHandler(options.flowAdapter, 'get')(req, res);
    })
  );

  const nodeTypeOpts = {
    nodeTypes: options.nodeTypesAdapter,
    ...(options.catalogueFetcher ? { catalogueFetcher: options.catalogueFetcher } : {}),
    ...(options.catalogueUrl ? { catalogueUrl: options.catalogueUrl } : {}),
  };
  app.get(
    `${base}/node-types`,
    ...gate,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      setNoStore(res);
      await listNodeTypesHandler(nodeTypeOpts)(req, res);
    })
  );
  app.get(
    `${base}/node-types/:type`,
    ...gate,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      setNoStore(res);
      await getNodeTypeHandler(nodeTypeOpts)(req, res);
    })
  );
  app.get(
    `${base}/palette/search`,
    ...gate,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      setNoStore(res);
      await searchPaletteHandler(nodeTypeOpts)(req, res);
    })
  );

  const httpAdminRoot = RED.settings.httpAdminRoot;
  registerGetLinkProposalRoutes(app, base, gate, options, httpAdminRoot);

  app.get(
    `${base}/propose`,
    ...gate,
    asyncRoute(
      getLinkProposeHandler(
        options.proposalStore,
        options.auditLog,
        options.flowAdapter,
        httpAdminRoot,
        options.nodeTypesAdapter
      )
    )
  );

  registerGetLinkDraftRoutes(app, base, gate, draftStore, options, httpAdminRoot);

  // GET links never mint tokens — reject any /links path under /mcp/a explicitly
  // (403 JSON) so a half-wired create route cannot appear by accident.
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
  app.get(
    `${base}/proposals`,
    ...gate,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      setNoStore(res);
      const link = req.accessLink;
      if (!link) {
        jsonError(res, 401, 'Access link required', 'access_link_missing');
        return;
      }
      const presentOpts = presentOptionsFor(req, httpAdminRoot);
      const include = resolveIncludeFromQuery(req.query);
      const listFilter = parseListProposalsQuery(req.query);
      let liveRev: string | undefined;
      try {
        liveRev = (await listFlows(options.flowAdapter)).rev;
      } catch {
        // Expiry is best-effort when live rev is unavailable.
      }
      const autoClosedCount = liveRev
        ? expireStalePendingProposals(options.proposalStore, liveRev)
        : 0;
      const page = listAccessibleProposals(options.proposalStore, link, presentOpts, listFilter);
      res.json({
        proposals: page.proposals.map(p =>
          presentAccessibleProposalForApi(
            options.proposalStore,
            link,
            p,
            { ...presentOpts, include },
            { includeConflicts: false }
          )
        ),
        ...listPageFields({ ...page, returned: page.proposals.length }),
        ...autoClosedFields(autoClosedCount),
      });
    })
  );

  app.get(
    `${base}/proposals/:id`,
    ...gate,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
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
        const include = resolveIncludeFromQuery(req.query);
        let liveRev: string | undefined;
        try {
          liveRev = (await listFlows(options.flowAdapter)).rev;
        } catch {
          // ignore
        }
        const presented = getAccessibleProposal(options.proposalStore, link, id, presentOpts);
        res.json(
          presentAccessibleProposalForApi(
            options.proposalStore,
            link,
            presented,
            { ...presentOpts, include },
            { ...(liveRev ? { liveRev } : {}) }
          )
        );
      } catch (error) {
        const mapped = aiOpsErrorToHttp(error, 'get');
        if (mapped) {
          res.status(mapped.statusCode).json({
            ...mapped.body,
            hint: mapped.body.hint ?? 'List proposals with GET …/proposals.',
          });
          return;
        }
        sendCaughtRouteError(res, error);
        return;
      }
    })
  );

  registerGetLinkWithdrawRoute(app, base, gate, options, httpAdminRoot);
  registerGetLinkDiffRoute(app, base, gate, options, httpAdminRoot);
}

function registerGetLinkWithdrawRoute(
  app: Express,
  base: string,
  gate: GetLinkGate,
  options: RegisterGetLinkRoutesOptions,
  httpAdminRoot?: string
): void {
  app.get(
    `${base}/proposals/:id/withdraw`,
    ...gate,
    asyncRoute((req: AuthenticatedRequest, res: Response) => {
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
      const confirm = req.query.confirm;
      if (confirm !== '1' && confirm !== 'true') {
        jsonError(
          res,
          400,
          'Withdraw over GET requires confirm=1',
          'confirm_required',
          channelErrorHint('confirm_required', 'get')
        );
        return;
      }
      const reason = typeof req.query.reason === 'string' ? req.query.reason : undefined;
      const presentOpts = presentOptionsFor(req, httpAdminRoot);
      const include = resolveIncludeFromQuery(req.query);
      try {
        const withdrawn = withdrawMyProposal(
          options.proposalStore,
          options.auditLog,
          link,
          id,
          reason,
          presentOpts
        );
        res.json(
          presentAccessibleProposalForApi(options.proposalStore, link, withdrawn, {
            ...presentOpts,
            include,
          })
        );
      } catch (error) {
        const mapped = aiOpsErrorToHttp(error, 'get');
        if (mapped) {
          // Fixed strings only — never echo exception text (CodeQL XSS / HTML).
          const code = mapped.body.code;
          jsonError(
            res,
            mapped.statusCode,
            CANONICAL_ERROR_TEXT[code] ?? 'Request failed',
            code,
            channelErrorHint(code, 'get')
          );
          return;
        }
        jsonError(res, 500, 'Internal server error', 'internal_error');
        return;
      }
    })
  );
}

function registerGetLinkDiffRoute(
  app: Express,
  base: string,
  gate: GetLinkGate,
  options: RegisterGetLinkRoutesOptions,
  httpAdminRoot?: string
): void {
  app.get(
    `${base}/proposals/:id/diff`,
    ...gate,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
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
        const proposal = getAccessibleProposal(
          options.proposalStore,
          link,
          id,
          presentOptionsFor(req, httpAdminRoot)
        );
        // `format=json|md` is the channel's response-type opt-in, not a diff format.
        const rawFormat = queryString(req.query, 'format');
        const resolved = resolveDiffFormat(
          rawFormat === 'json' || rawFormat === 'md' ? undefined : rawFormat
        );
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
        sendCaughtRouteError(res, error);
        return;
      }
    })
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
  app.get(
    `${base}/draft/new`,
    ...gate,
    asyncRoute(getLinkDraftNewHandler(draftStore, options.flowAdapter))
  );
  app.get(
    `${base}/draft/:draftId/append`,
    ...gate,
    asyncRoute(getLinkDraftAppendHandler(draftStore))
  );
  app.get(
    `${base}/draft/:draftId/submit`,
    ...gate,
    asyncRoute(
      getLinkDraftSubmitHandler(
        draftStore,
        options.proposalStore,
        options.auditLog,
        options.flowAdapter,
        httpAdminRoot,
        options.nodeTypesAdapter
      )
    )
  );
}
