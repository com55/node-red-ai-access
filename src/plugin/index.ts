/**
 * Node-RED plugin entry for @com55/node-red-ai-access.
 *
 * Registers the /ai-access dashboard, access links, proposals, flows, logs APIs,
 * and the /mcp/rpc Streamable HTTP endpoint.
 */

import { existsSync } from 'node:fs';

import type { NextFunction, Request, Response } from 'express';

import { resolveAiAccessPaths } from '../storage/paths.js';

import { requireAccessLink } from './access-link-auth.js';
import { editorAuthTokenKey } from './auth-token-key.js';
import {
  mcpApiBase,
  mcpRpcPath,
  dashboardPath,
  normalizeHttpAdminRoot,
  requireAdminReadOrAccessLink,
  requireAdminSession,
  requireAdminSessionOrAccessLink,
  requireAiFeatures,
  requireStarPermission,
  resolvePermission,
} from './auth.js';
import { requireJsonContentType } from './content-type.js';
import { aiCorsMiddleware, installAiCorsMiddleware } from './cors.js';
import { discoveryIndexHandler, mcpApiNotFoundHandler } from './discovery.js';
import { EDITOR_SIDEBAR_ASSET_VERSION, renderEditorSidebarJs } from './editor-sidebar.js';
import { listFlowsHandler } from './flows-routes.js';
import { registerGetLinkRoutes } from './get-link-routes.js';
import { attachMcpJsonErrorHandlers } from './json-errors.js';
import {
  getFlowOrSummaryHandler,
  getNodeFieldHandler,
  getNodeHandler,
  searchFlowsHandler,
} from './layered-read-routes.js';
import {
  createConfiguredLinkStore,
  createLinkHandler,
  listLinksHandler,
  revokeLinkHandler,
} from './links.js';
import { listLogsHandler } from './logs-routes.js';
import { mcpRpcMethodNotAllowed, mcpRpcPostHandler } from './mcp-rpc.js';
import {
  getNodeTypeHandler,
  listNodeTypesHandler,
  searchPaletteHandler,
} from './node-types-routes.js';
import {
  describeOAuthRouteCollision,
  scanOAuthRouteCollisions,
  type StaticMount,
  type OAuthRouteCollision,
  LocalOAuthProvider,
  OAuthStore,
  makeOAuthHandlers,
} from './oauth.js';
import { openApiJsonHandler, openApiYamlHandler } from './openapi.js';
import { renderMcpPage } from './page.js';
import { liveFlowLabelsFromFlows, setRequestFlowLabels } from './proposal-present.js';
import { configureProposalTtl, createDebouncedSync, syncOpenProposals } from './proposal-sync.js';
import {
  approveProposalHandler,
  createProposalHandler,
  getProposalDiffHandler,
  getProposalHandler,
  listProposalsHandler,
  rejectProposalHandler,
  withdrawProposalHandler,
  resolveProposalHandler,
  resolveProposalConflictHandler,
  recheckProposalHandler,
} from './proposals-routes.js';
import { createAiAccessRateLimiter, createLiveAiAccessDualRateLimiters } from './rate-limit.js';
import { redactionAuditMiddleware } from './redaction-audit.js';
import { asyncRoute } from './route-errors.js';
import { aiRedactingAdapter } from './secret-redaction.js';
import { createPluginServices, type CreatePluginServicesOptions } from './services.js';
import {
  checkPublicUrlHandler,
  getSettingsHandler,
  putSettingsHandler,
} from './settings-routes.js';
import { isAdminAuthEnabled } from './settings.js';
import { buildStatus } from './status.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

export type {
  AccessLinkAuthInfo,
  AiAccessCapabilities,
  AiAccessPermission,
  AiAccessSettings,
  AiAccessStatus,
  NodeRedPluginAPI,
} from './types.js';

export { AccessLinkStore } from '../access/index.js';
export {
  ACCESS_LINK_INVALID_MESSAGE,
  ACCESS_LINK_MISSING_MESSAGE,
  requireAccessLink,
} from './access-link-auth.js';
export { getStorageDir } from './storage.js';
export {
  areAiFeaturesEnabled,
  bindSettingsStore,
  isAdminAuthEnabled,
  resolveAiAccessSettings,
} from './settings.js';
export { createPluginServices } from './services.js';
export { MAX_PROPOSAL_JSON_BYTES } from './ai-ops.js';
export { SettingsStore } from '../storage/settings-store.js';
export {
  EDITOR_SIDEBAR_ASSET_VERSION,
  renderEditorSidebarJs,
  renderEditorSidebarLoaderHtml,
} from './editor-sidebar.js';
export { packageVersion } from './package-version.js';

const PLUGIN_ID = 'com55-ai-access';
const syncCleanup = new WeakMap<NodeRedPluginAPI, () => void>();

/**
 * True for MCP Streamable HTTP GET requests (they ask for `text/event-stream`
 * and not HTML). Browsers opening `/mcp` are redirected to `/ai-access`.
 */
/** Media ranges from an Accept header with q > 0 (q=0 means "not acceptable"). */
export function acceptedMediaTypes(accept: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of String(accept ?? '').split(',')) {
    const [type, ...params] = part.split(';').map(s => s.trim().toLowerCase());
    if (!type) continue;
    const q = params.find(p => p.startsWith('q='));
    const value = q ? Number(q.slice(2)) : 1;
    if (Number.isFinite(value) && value > 0) out.add(type);
  }
  return out;
}

export function isMcpStreamRequest(req: Request): boolean {
  const types = acceptedMediaTypes(req.headers.accept);
  return types.has('text/event-stream') && !types.has('text/html');
}

/** Public shell + discovery (no authorization middleware — safe to extract). */
function registerMcpShellAndDiscovery(
  RED: NodeRedPluginAPI,
  limiter: ReturnType<typeof createLiveAiAccessDualRateLimiters>['ip'],
  tokenLimiter: ReturnType<typeof createLiveAiAccessDualRateLimiters>['token']
): void {
  // tokenLimiter after the IP limiter: when a Bearer token is present its
  // per-token RateLimit-* headers replace the per-IP ones (both still enforced).
  RED.httpAdmin.get('/mcp/api/v1', limiter, tokenLimiter, discoveryIndexHandler(RED));
  RED.httpAdmin.get('/mcp/api/v1/', limiter, tokenLimiter, discoveryIndexHandler(RED));
  RED.httpAdmin.get('/mcp/api/v1/openapi.yaml', limiter, tokenLimiter, openApiYamlHandler());
  RED.httpAdmin.get('/mcp/api/v1/openapi.json', limiter, tokenLimiter, openApiJsonHandler());

  // Editor sidebar assets — must not be cached across plugin upgrades.
  // Companion ai-access.html is a thin loader with ?v= cache-bust.
  RED.httpAdmin.get(
    '/mcp/editor/ai-access-sidebar.js',
    limiter,
    (_req: AuthenticatedRequest, res: Response) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('X-AI-Access-Sidebar-Version', EDITOR_SIDEBAR_ASSET_VERSION);
      res.type('application/javascript').status(200).send(renderEditorSidebarJs());
    }
  );
}

const PROPOSAL_PRESENT_PATH =
  /^\/mcp\/(?:api\/v1\/proposals|rpc$|a\/[^/]+\/(?:proposals|propose|draft))/;

export function registerRoutes(
  RED: NodeRedPluginAPI,
  serviceOptions: CreatePluginServicesOptions = {}
): void {
  // Keep `limiter` / `tokenLimiter` as locals so CodeQL missing-rate-limiting
  // can see authorization routes are rate-limited.
  const services = createPluginServices(RED, {
    ...serviceOptions,
    linkStore: serviceOptions.linkStore ?? createConfiguredLinkStore(RED),
  });

  configureProposalTtl(() => services.settingsStore.getEffective().proposalTtlDays);
  syncCleanup.get(RED)?.();
  const proposalSync = createDebouncedSync(
    () => syncOpenProposals(services.proposalStore, services.flowAdapter),
    500
  );
  const cleanup = () => {
    proposalSync.cancel();
    RED.events?.removeListener?.('flows:started', proposalSync.trigger);
  };
  syncCleanup.set(RED, cleanup);
  RED.events?.on('flows:started', proposalSync.trigger);

  const dualLimiters = createLiveAiAccessDualRateLimiters(() =>
    services.settingsStore.getEffective()
  );
  const { ip: limiter, token: tokenLimiter } = dualLimiters;
  const oauthStore = new OAuthStore(
    resolveAiAccessPaths(RED.settings.userDir),
    () => services.settingsStore.getEffective().oauth.dcrMaxClients
  );
  const publicBase = () => services.settingsStore.getEffective().publicBaseUrl;
  const mcpUrl = () => `${publicBase().replace(/\/$/, '')}/mcp`;
  const oauthProvider = new LocalOAuthProvider(
    oauthStore,
    mcpUrl,
    () => services.settingsStore.getEffective().oauth.accessTokenTtlSec,
    () => services.settingsStore.getEffective().oauth.refreshIdleTtlSec,
    () => services.settingsStore.getEffective().oauth.refreshMaxLifetimeSec
  );
  const oauth = makeOAuthHandlers(RED, oauthProvider, publicBase, mcpUrl);

  // AI-facing CORS: no headers by default; echo allow-listed origins only.
  installAiCorsMiddleware(
    RED.httpAdmin,
    aiCorsMiddleware(() => services.settingsStore.getEffective().corsAllowedOrigins)
  );
  const staticMounts = (value: unknown): (string | StaticMount)[] =>
    (Array.isArray(value) ? value : value ? [value] : []).flatMap(
      (m: unknown): (string | StaticMount)[] => {
        if (typeof m === 'string') return [m];
        const o = m as { path?: unknown; root?: unknown } | null;
        return o && typeof o.path === 'string'
          ? [{ path: o.path, root: typeof o.root === 'string' ? o.root : undefined }]
          : [];
      }
    );
  const routeStatus = {
    authorization: [] as string[],
    metadata: [] as string[],
    details: [] as (OAuthRouteCollision & { kind: 'authorization' | 'metadata' })[],
    httpNodeRootFallback: RED.settings.httpNodeRoot === false || !RED.httpNode,
  };
  let lastLogged = '';
  const refreshCollisions = () => {
    const scan = scanOAuthRouteCollisions({
      httpAdmin: RED.httpAdmin,
      httpNode: RED.httpNode,
      httpAdminRoot: RED.settings.httpAdminRoot,
      httpNodeRoot: RED.settings.httpNodeRoot,
      metadataFallback: routeStatus.httpNodeRootFallback,
      eachNode: RED.nodes ? listener => RED.nodes?.eachNode(listener) : undefined,
      staticDirs: staticMounts(RED.settings.httpStatic),
      httpStaticRoot: RED.settings.httpStaticRoot,
      fileExists: existsSync,
    });
    const auth = scan.authorization;
    const meta = scan.metadata;
    routeStatus.authorization = auth.map(describeOAuthRouteCollision);
    routeStatus.metadata = meta.map(describeOAuthRouteCollision);
    routeStatus.details = [
      ...auth.map(c => ({ ...c, kind: 'authorization' as const })),
      ...meta.map(c => ({ ...c, kind: 'metadata' as const })),
    ];
    const lines = [
      ...routeStatus.authorization.map(c => `${c} — OAuth authorization routes disabled`),
      ...routeStatus.metadata.map(c => `${c} — OAuth metadata disabled`),
    ];
    const key = lines.join('\n');
    if (key !== lastLogged)
      for (const line of lines) RED.log?.warn?.(`AI Access OAuth route collision: ${line}`);
    lastLogged = key;
  };
  refreshCollisions();
  RED.events?.on('flows:started', refreshCollisions);
  const authorizeLimiter = createAiAccessRateLimiter({ windowMs: 60_000, maxPerIp: 30 });
  const oauthServerMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (
      !services.settingsStore.getEffective().oauth.enabled ||
      routeStatus.authorization.length ||
      !req.path.startsWith('/mcp/oauth/')
    ) {
      next();
      return;
    }
    // Same gate as aia_ links: disabled AI Access blocks consent, token, register, revoke.
    // Consent pages get the shared per-IP limiter plus a tighter one for /authorize,
    // which creates pending in-memory requests.
    const path = req.path.replace(/\/+$/, '').toLowerCase();
    const run = () => requireAiFeatures(RED)(req, res, () => oauth.server(req, res, next));
    if (path === '/mcp/oauth/authorize') limiter(req, res, () => authorizeLimiter(req, res, run));
    else if (path.startsWith('/mcp/oauth/consent/')) limiter(req, res, run);
    else run();
  };
  (oauthServerMiddleware as typeof oauthServerMiddleware & { oauthOwned: boolean }).oauthOwned =
    true;
  RED.httpAdmin.use(oauthServerMiddleware);
  const metadataHandler = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!services.settingsStore.getEffective().oauth.enabled || routeStatus.metadata.length) {
      next();
      return;
    }
    oauth.metadata(req, res, next);
  };
  (metadataHandler as typeof metadataHandler & { oauthOwned: boolean }).oauthOwned = true;
  if (routeStatus.httpNodeRootFallback) RED.httpAdmin.use('/mcp', metadataHandler);
  else RED.httpNode?.use(metadataHandler);
  RED.httpAdmin.get(
    '/mcp/api/v1/oauth/clients',
    limiter,
    tokenLimiter,
    requireAdminSession(RED, 'api'),
    (req: AuthenticatedRequest, res: Response) =>
      res.json({
        clients: oauthStore.data.clients.map(c => ({
          client_id: c.client_id,
          client_name: c.client_name,
          redirect_uris: c.redirect_uris,
          lastUsedAt: c.lastUsedAt,
        })),
      })
  );
  RED.httpAdmin.get(
    '/mcp/api/v1/oauth/status',
    limiter,
    tokenLimiter,
    requireAdminSession(RED, 'api'),
    (req: AuthenticatedRequest, res: Response) => {
      // Absolute httpStatic filesystem paths are only shown to full-permission admins.
      const full = !isAdminAuthEnabled(RED.settings) || resolvePermission(req) === '*';
      res.json({
        ...routeStatus,
        details: full
          ? routeStatus.details
          : routeStatus.details.map(({ file: _file, ...rest }) => rest),
        collisions: [...routeStatus.authorization, ...routeStatus.metadata],
        oauthEnabled: services.settingsStore.getEffective().oauth.enabled,
      });
    }
  );
  RED.httpAdmin.delete(
    '/mcp/api/v1/oauth/clients/:id',
    limiter,
    tokenLimiter,
    requireAdminSession(RED, 'api'),
    requireStarPermission(RED),
    (req: AuthenticatedRequest, res: Response) =>
      res.json({ revoked: oauthStore.revokeClient(String(req.params.id)) })
  );

  // Resolve live flow labels once per proposal-related request so every channel
  // (REST, GET link, MCP) and endpoint (list, get, submit, …) presents the same
  // flowLabel/title for proposals whose stored snapshot lacks a tab label.
  RED.httpAdmin.use((req: Request, _res: Response, next: NextFunction) => {
    if (!PROPOSAL_PRESENT_PATH.test(req.path)) {
      next();
      return;
    }
    services.flowAdapter
      .getFlows()
      .then(snapshot => setRequestFlowLabels(req, liveFlowLabelsFromFlows(snapshot.flows)))
      .catch(() => undefined)
      .finally(() => next());
  });

  // Self-contained GET access links for headerless HTTP clients (`/mcp/a/<token>/…`).
  // Reuse the same IP+token limiter instances as REST/MCP so one token shares one bucket.
  // Audit `[REDACTED]` counts on AI (access-link) JSON responses under /mcp/.
  // Path-scoped inside the middleware (AI routes under /mcp/ only); a mounted
  // `use('/mcp', …)` would trip the plugin's own http-in collision detector.
  RED.httpAdmin.use(redactionAuditMiddleware(services.auditLog));

  registerGetLinkRoutes(RED, {
    linkStore: services.linkStore,
    proposalStore: services.proposalStore,
    auditLog: services.auditLog,
    // GET links are AI-only: every flow read is redacted.
    flowAdapter: aiRedactingAdapter(services.flowAdapter),
    nodeTypesAdapter: services.nodeTypesAdapter,
    ...(services.catalogueFetcher ? { catalogueFetcher: services.catalogueFetcher } : {}),
    ...(services.catalogueUrl ? { catalogueUrl: services.catalogueUrl } : {}),
    rateLimiters: dualLimiters,
  });

  // Registered here (not in a helper) so CodeQL missing-rate-limiting sees the limiter.
  // Dashboard shell is public: browser reads editor localStorage Bearer, then calls APIs.
  // Inline CSS/JS — must not be cached across plugin upgrades (no-store).
  RED.httpAdmin.get(
    '/ai-access',
    limiter,
    tokenLimiter,
    (_req: AuthenticatedRequest, res: Response) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res
        .type('html')
        .status(200)
        .send(
          renderMcpPage({
            apiBase: mcpApiBase(RED.settings.httpAdminRoot),
            mcpRpc: mcpRpcPath(RED.settings.httpAdminRoot),
            editorRoot: normalizeHttpAdminRoot(RED.settings.httpAdminRoot),
            authTokenKey: editorAuthTokenKey(RED.settings.httpAdminRoot),
            dashboardPath: dashboardPath(RED.settings.httpAdminRoot),
          })
        );
    }
  );

  // `/mcp` is the MCP endpoint (OAuth protected resource). Same content negotiation
  // as before 0.2.0-beta.3: MCP Streamable HTTP GETs (Accept: text/event-stream
  // without text/html) fall through; everything else (browsers) is redirected.
  RED.httpAdmin.get(
    '/mcp',
    limiter,
    (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      if (isMcpStreamRequest(req)) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, dashboardPath(RED.settings.httpAdminRoot));
    }
  );

  registerMcpShellAndDiscovery(RED, limiter, tokenLimiter);

  RED.httpAdmin.get(
    '/mcp/api/v1/status',
    limiter,
    tokenLimiter,
    requireAdminSessionOrAccessLink(RED, token => services.linkStore.validateResult(token)),
    asyncRoute((req: AuthenticatedRequest, res: Response) => {
      res.json(buildStatus(RED, req));
    })
  );

  // Settings API (sidebar AI Access tab) — admin session; PUT requires *.
  RED.httpAdmin.get(
    '/mcp/api/v1/settings',
    limiter,
    tokenLimiter,
    requireAdminSession(RED, 'api'),
    asyncRoute(getSettingsHandler(RED, services.settingsStore))
  );
  RED.httpAdmin.put(
    '/mcp/api/v1/settings',
    limiter,
    tokenLimiter,
    requireAdminSession(RED, 'api'),
    requireStarPermission(RED),
    requireJsonContentType('rest'),
    asyncRoute(putSettingsHandler(RED, services.settingsStore, services.linkStore))
  );

  RED.httpAdmin.post(
    '/mcp/api/v1/settings/check-public-url',
    limiter,
    tokenLimiter,
    requireAdminSession(RED, 'api'),
    requireStarPermission(RED),
    requireJsonContentType('rest'),
    asyncRoute(checkPublicUrlHandler(RED))
  );

  const linkGuards = [
    limiter,
    tokenLimiter,
    requireAdminSession(RED, 'api'),
    requireAiFeatures(RED),
    requireStarPermission(RED),
  ];

  RED.httpAdmin.get(
    '/mcp/api/v1/links',
    ...linkGuards,
    asyncRoute(listLinksHandler(RED, services.linkStore))
  );
  RED.httpAdmin.post(
    '/mcp/api/v1/links',
    ...linkGuards,
    asyncRoute(createLinkHandler(RED, services.linkStore, services.auditLog))
  );
  RED.httpAdmin.delete(
    '/mcp/api/v1/links/:id',
    ...linkGuards,
    asyncRoute(revokeLinkHandler(RED, services.linkStore, services.auditLog))
  );

  const sharedRead = [
    limiter,
    tokenLimiter,
    requireAiFeatures(RED),
    requireAdminReadOrAccessLink(RED, token => services.linkStore.validateResult(token)),
  ];

  const flows = services.flowAdapter;
  const nodeTypes = services.nodeTypesAdapter;
  const nodeTypeRouteOpts = {
    nodeTypes,
    ...(services.catalogueFetcher ? { catalogueFetcher: services.catalogueFetcher } : {}),
    ...(services.catalogueUrl ? { catalogueUrl: services.catalogueUrl } : {}),
  };
  RED.httpAdmin.get('/mcp/api/v1/flows', ...sharedRead, asyncRoute(listFlowsHandler(flows)));
  RED.httpAdmin.get(
    '/mcp/api/v1/flows/:id',
    ...sharedRead,
    asyncRoute(getFlowOrSummaryHandler(flows))
  );
  RED.httpAdmin.get('/mcp/api/v1/nodes/:id', ...sharedRead, asyncRoute(getNodeHandler(flows)));
  RED.httpAdmin.get(
    '/mcp/api/v1/nodes/:id/field/:name',
    ...sharedRead,
    asyncRoute(getNodeFieldHandler(flows))
  );
  RED.httpAdmin.get('/mcp/api/v1/search', ...sharedRead, asyncRoute(searchFlowsHandler(flows)));
  RED.httpAdmin.get(
    '/mcp/api/v1/node-types',
    ...sharedRead,
    asyncRoute(listNodeTypesHandler(nodeTypeRouteOpts))
  );
  RED.httpAdmin.get(
    '/mcp/api/v1/node-types/:type',
    ...sharedRead,
    asyncRoute(getNodeTypeHandler(nodeTypeRouteOpts))
  );
  RED.httpAdmin.get(
    '/mcp/api/v1/palette/search',
    ...sharedRead,
    asyncRoute(searchPaletteHandler(nodeTypeRouteOpts))
  );

  // Proposal routes stay in this function so CodeQL can see the local limiters
  // (passing them into a helper breaks missing-rate-limiting dataflow).
  const httpAdminRoot = RED.settings.httpAdminRoot;
  RED.httpAdmin.get(
    '/mcp/api/v1/proposals',
    ...sharedRead,
    asyncRoute(listProposalsHandler(services.proposalStore, services.flowAdapter, httpAdminRoot))
  );
  RED.httpAdmin.get(
    '/mcp/api/v1/proposals/:id',
    ...sharedRead,
    asyncRoute(getProposalHandler(services.proposalStore, httpAdminRoot, services.flowAdapter))
  );
  RED.httpAdmin.get(
    '/mcp/api/v1/proposals/:id/diff',
    ...sharedRead,
    asyncRoute(getProposalDiffHandler(services.proposalStore, services.flowAdapter))
  );
  RED.httpAdmin.post(
    '/mcp/api/v1/proposals',
    limiter,
    tokenLimiter,
    requireJsonContentType('rest'),
    requireAccessLink(RED, services.linkStore, 'rest'),
    asyncRoute(
      createProposalHandler(
        services.proposalStore,
        services.auditLog,
        services.flowAdapter,
        httpAdminRoot,
        services.nodeTypesAdapter
      )
    )
  );
  RED.httpAdmin.post(
    '/mcp/api/v1/proposals/:id/approve',
    ...linkGuards,
    requireJsonContentType('rest'),
    asyncRoute(approveProposalHandler(services.proposalService, httpAdminRoot))
  );
  RED.httpAdmin.post(
    '/mcp/api/v1/proposals/:id/reject',
    ...linkGuards,
    requireJsonContentType('rest'),
    asyncRoute(rejectProposalHandler(services.proposalService, httpAdminRoot))
  );
  RED.httpAdmin.post(
    '/mcp/api/v1/proposals/:id/withdraw',
    limiter,
    tokenLimiter,
    requireJsonContentType('rest'),
    requireAccessLink(RED, services.linkStore, 'rest'),
    asyncRoute(withdrawProposalHandler(services.proposalStore, services.auditLog, httpAdminRoot))
  );

  RED.httpAdmin.post(
    '/mcp/api/v1/proposals/:id/resolve-conflict',
    ...linkGuards,
    requireJsonContentType('rest'),
    asyncRoute(
      resolveProposalConflictHandler(
        services.proposalStore,
        services.auditLog,
        flows,
        httpAdminRoot
      )
    )
  );
  RED.httpAdmin.post(
    '/mcp/api/v1/proposals/:id/recheck',
    ...linkGuards,
    asyncRoute(recheckProposalHandler(services.proposalStore, flows, httpAdminRoot))
  );
  RED.httpAdmin.post(
    '/mcp/api/v1/proposals/:id/resolve',
    limiter,
    tokenLimiter,
    requireJsonContentType('rest'),
    requireAccessLink(RED, services.linkStore, 'rest'),
    asyncRoute(
      resolveProposalHandler(
        services.proposalStore,
        services.auditLog,
        flows,
        httpAdminRoot,
        nodeTypes
      )
    )
  );

  const mcpRpcGuards = [
    limiter,
    tokenLimiter,
    (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (
        !services.settingsStore.getEffective().oauth.enabled ||
        authHeader?.toLowerCase().startsWith('bearer aia_')
      ) {
        if (services.settingsStore.getEffective().oauth.enabled) {
          const setHeader = res.setHeader.bind(res);
          res.setHeader = ((name: string, value: number | string | readonly string[]) => {
            if (
              name.toLowerCase() === 'www-authenticate' &&
              typeof value === 'string' &&
              !value.includes('resource_metadata=')
            ) {
              const prm = `${publicBase().replace(/\/$/, '')}${routeStatus.httpNodeRootFallback ? '/mcp' : ''}/.well-known/oauth-protected-resource/mcp`;
              value += `, resource_metadata="${prm}", scope="read propose"`;
            }
            return setHeader(name, value);
          }) as typeof res.setHeader;
        }
        requireAccessLink(RED, services.linkStore, 'mcp')(req, res, next);
        return;
      }
      requireAiFeatures(RED)(req, res, () => oauth.auth(req, res, next));
    },
  ];
  RED.httpAdmin.post(
    '/mcp/rpc',
    ...mcpRpcGuards,
    requireJsonContentType('mcp'),
    asyncRoute(mcpRpcPostHandler(RED, services))
  );
  RED.httpAdmin.get('/mcp/rpc', ...mcpRpcGuards, mcpRpcMethodNotAllowed);
  RED.httpAdmin.delete('/mcp/rpc', ...mcpRpcGuards, mcpRpcMethodNotAllowed);
  // `/mcp` is the OAuth protected resource (PRM `resource`) and the URL users add in
  // ChatGPT/Claude, so it must be a working MCP endpoint too (alias of /mcp/rpc).
  // Without this, OAuth succeeds but tools/list POSTs to /mcp got 404.
  RED.httpAdmin.post(
    '/mcp',
    ...mcpRpcGuards,
    requireJsonContentType('mcp'),
    asyncRoute(mcpRpcPostHandler(RED, services))
  );
  RED.httpAdmin.get('/mcp', ...mcpRpcGuards, mcpRpcMethodNotAllowed);
  RED.httpAdmin.delete('/mcp', ...mcpRpcGuards, mcpRpcMethodNotAllowed);

  RED.httpAdmin.get(
    '/mcp/api/v1/logs',
    limiter,
    tokenLimiter,
    requireAdminSession(RED, 'api'),
    requireAiFeatures(RED),
    asyncRoute(listLogsHandler(services.auditLog, services.linkStore))
  );

  // JSON 404 for unmatched /mcp/api/v1 routes (never HTML "Cannot GET").
  // Must be registered after all concrete /mcp/api/v1 handlers.
  RED.httpAdmin.use('/mcp/api/v1', mcpApiNotFoundHandler());

  // JSON / JSON-RPC errors for /mcp* on plugin + parent editor-api apps
  // (body-parser lives on the parent; nested runtime.adminApp alone never sees it).
  attachMcpJsonErrorHandlers(RED);
}

/**
 * Node-RED plugin factory. Loaded via `ai-access.cjs` → `dist/plugin.cjs`.
 */
function registerAiAccessPlugin(RED: NodeRedPluginAPI): void {
  RED.plugins.registerPlugin(PLUGIN_ID, {
    type: 'com55-ai-access',
    onremove() {
      syncCleanup.get(RED)?.();
      syncCleanup.delete(RED);
    },
    onadd() {
      registerRoutes(RED);
      RED.log?.info?.('Node-RED AI Access plugin loaded (dashboard /ai-access, MCP /mcp)');
    },
  });
}

export default registerAiAccessPlugin;
