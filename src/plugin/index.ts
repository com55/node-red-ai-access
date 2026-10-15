/**
 * Node-RED plugin entry for @com55/node-red-ai-access.
 *
 * Registers /mcp admin page, access links, proposals, flows, logs APIs,
 * and the /mcp/rpc Streamable HTTP endpoint.
 */

import type { Response } from 'express';

import { requireAccessLink } from './access-link-auth.js';
import { editorAuthTokenKey } from './auth-token-key.js';
import {
  mcpApiBase,
  mcpRpcPath,
  normalizeHttpAdminRoot,
  requireAdminReadOrAccessLink,
  requireAdminSession,
  requireAdminSessionOrAccessLink,
  requireAiFeatures,
  requireStarPermission,
} from './auth.js';
import { discoveryIndexHandler, mcpApiNotFoundHandler } from './discovery.js';
import { getFlowHandler, listFlowsHandler } from './flows-routes.js';
import { registerGetLinkRoutes } from './get-link-routes.js';
import { attachMcpJsonErrorHandlers } from './json-errors.js';
import {
  createConfiguredLinkStore,
  createLinkHandler,
  listLinksHandler,
  revokeLinkHandler,
} from './links.js';
import { listLogsHandler } from './logs-routes.js';
import { mcpRpcMethodNotAllowed, mcpRpcPostHandler } from './mcp-rpc.js';
import { openApiYamlHandler } from './openapi.js';
import { renderMcpPage } from './page.js';
import {
  approveProposalHandler,
  createProposalHandler,
  getProposalDiffHandler,
  getProposalHandler,
  listProposalsHandler,
  rejectProposalHandler,
} from './proposals-routes.js';
import { createAiAccessDualRateLimiters } from './rate-limit.js';
import { createPluginServices, type CreatePluginServicesOptions } from './services.js';
import { getSettingsHandler, putSettingsHandler } from './settings-routes.js';
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

const PLUGIN_ID = 'com55-ai-access';

/** Public shell + discovery (no authorization middleware — safe to extract). */
function registerMcpShellAndDiscovery(
  RED: NodeRedPluginAPI,
  limiter: ReturnType<typeof createAiAccessDualRateLimiters>['ip']
): void {
  // Page shell is public: browser reads editor localStorage Bearer, then calls APIs.
  // Inline CSS/JS — must not be cached across plugin upgrades (no-store).
  RED.httpAdmin.get('/mcp', limiter, (_req: AuthenticatedRequest, res: Response) => {
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
        })
      );
  });

  RED.httpAdmin.get('/mcp/api/v1', limiter, discoveryIndexHandler(RED));
  RED.httpAdmin.get('/mcp/api/v1/', limiter, discoveryIndexHandler(RED));
  RED.httpAdmin.get('/mcp/api/v1/openapi.yaml', limiter, openApiYamlHandler());
}

export function registerRoutes(
  RED: NodeRedPluginAPI,
  serviceOptions: CreatePluginServicesOptions = {}
): void {
  // Keep `limiter` / `tokenLimiter` as locals so CodeQL missing-rate-limiting
  // can see authorization routes are rate-limited.
  const { ip: limiter, token: tokenLimiter } = createAiAccessDualRateLimiters(
    RED.settings.aiAccess ?? null
  );
  const services = createPluginServices(RED, {
    ...serviceOptions,
    linkStore: serviceOptions.linkStore ?? createConfiguredLinkStore(RED),
  });

  // Self-contained GET access links for headerless HTTP clients (`/mcp/a/<token>/…`).
  registerGetLinkRoutes(RED, {
    linkStore: services.linkStore,
    proposalStore: services.proposalStore,
    auditLog: services.auditLog,
    flowAdapter: services.flowAdapter,
    rateLimit: RED.settings.aiAccess ?? {},
  });

  registerMcpShellAndDiscovery(RED, limiter);

  RED.httpAdmin.get(
    '/mcp/api/v1/status',
    limiter,
    tokenLimiter,
    requireAdminSessionOrAccessLink(RED, token => services.linkStore.validate(token)),
    (req: AuthenticatedRequest, res: Response) => {
      res.json(buildStatus(RED, req));
    }
  );

  // Settings API (sidebar AI Access tab) — admin session; PUT requires *.
  RED.httpAdmin.get(
    '/mcp/api/v1/settings',
    limiter,
    requireAdminSession(RED, 'api'),
    getSettingsHandler(RED, services.settingsStore)
  );
  RED.httpAdmin.put(
    '/mcp/api/v1/settings',
    limiter,
    requireAdminSession(RED, 'api'),
    requireStarPermission(RED),
    putSettingsHandler(RED, services.settingsStore, services.linkStore)
  );

  const linkGuards = [
    limiter,
    requireAdminSession(RED, 'api'),
    requireAiFeatures(RED),
    requireStarPermission(RED),
  ];

  RED.httpAdmin.get('/mcp/api/v1/links', ...linkGuards, listLinksHandler(RED, services.linkStore));
  RED.httpAdmin.post(
    '/mcp/api/v1/links',
    ...linkGuards,
    createLinkHandler(RED, services.linkStore)
  );
  RED.httpAdmin.delete(
    '/mcp/api/v1/links/:id',
    ...linkGuards,
    revokeLinkHandler(RED, services.linkStore)
  );

  const sharedRead = [
    limiter,
    tokenLimiter,
    requireAiFeatures(RED),
    requireAdminReadOrAccessLink(RED, token => services.linkStore.validate(token)),
  ];

  RED.httpAdmin.get('/mcp/api/v1/flows', ...sharedRead, listFlowsHandler(services.flowAdapter));
  RED.httpAdmin.get('/mcp/api/v1/flows/:id', ...sharedRead, getFlowHandler(services.flowAdapter));

  // Proposal routes stay in this function so CodeQL can see the local limiters
  // (passing them into a helper breaks missing-rate-limiting dataflow).
  const httpAdminRoot = RED.settings.httpAdminRoot;
  RED.httpAdmin.get(
    '/mcp/api/v1/proposals',
    ...sharedRead,
    listProposalsHandler(services.proposalStore, httpAdminRoot)
  );
  RED.httpAdmin.get(
    '/mcp/api/v1/proposals/:id',
    ...sharedRead,
    getProposalHandler(services.proposalStore, httpAdminRoot)
  );
  RED.httpAdmin.get(
    '/mcp/api/v1/proposals/:id/diff',
    ...sharedRead,
    getProposalDiffHandler(services.proposalStore, services.flowAdapter)
  );
  RED.httpAdmin.post(
    '/mcp/api/v1/proposals',
    limiter,
    tokenLimiter,
    requireAccessLink(RED, services.linkStore),
    createProposalHandler(
      services.proposalStore,
      services.auditLog,
      services.flowAdapter,
      httpAdminRoot
    )
  );
  RED.httpAdmin.post(
    '/mcp/api/v1/proposals/:id/approve',
    ...linkGuards,
    approveProposalHandler(services.proposalService, httpAdminRoot)
  );
  RED.httpAdmin.post(
    '/mcp/api/v1/proposals/:id/reject',
    ...linkGuards,
    rejectProposalHandler(services.proposalService, httpAdminRoot)
  );

  const mcpRpcGuards = [limiter, tokenLimiter, requireAccessLink(RED, services.linkStore)];
  RED.httpAdmin.post('/mcp/rpc', ...mcpRpcGuards, mcpRpcPostHandler(RED, services));
  RED.httpAdmin.get('/mcp/rpc', ...mcpRpcGuards, mcpRpcMethodNotAllowed);
  RED.httpAdmin.delete('/mcp/rpc', ...mcpRpcGuards, mcpRpcMethodNotAllowed);

  RED.httpAdmin.get(
    '/mcp/api/v1/logs',
    limiter,
    requireAdminSession(RED, 'api'),
    requireAiFeatures(RED),
    listLogsHandler(services.auditLog)
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
    onadd() {
      registerRoutes(RED);
      RED.log?.info?.('Node-RED AI Access plugin loaded (/mcp)');
    },
  });
}

export default registerAiAccessPlugin;
