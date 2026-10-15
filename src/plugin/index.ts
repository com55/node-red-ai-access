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
  normalizeHttpAdminRoot,
  requireAdminReadOrAccessLink,
  requireAdminSession,
  requireAiFeatures,
  requireStarPermission,
} from './auth.js';
import { getFlowHandler, listFlowsHandler } from './flows-routes.js';
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
  getProposalHandler,
  listProposalsHandler,
  rejectProposalHandler,
} from './proposals-routes.js';
import { createAiAccessRateLimiter } from './rate-limit.js';
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

export function registerRoutes(
  RED: NodeRedPluginAPI,
  serviceOptions: CreatePluginServicesOptions = {}
): void {
  const limiter = createAiAccessRateLimiter();
  const services = createPluginServices(RED, {
    ...serviceOptions,
    linkStore: serviceOptions.linkStore ?? createConfiguredLinkStore(RED),
  });

  // Page shell is public: browser reads editor localStorage Bearer, then calls APIs.
  RED.httpAdmin.get('/mcp', limiter, (_req: AuthenticatedRequest, res: Response) => {
    res
      .type('html')
      .status(200)
      .send(
        renderMcpPage({
          apiBase: mcpApiBase(RED.settings.httpAdminRoot),
          editorRoot: normalizeHttpAdminRoot(RED.settings.httpAdminRoot),
          authTokenKey: editorAuthTokenKey(RED.settings.httpAdminRoot),
        })
      );
  });

  RED.httpAdmin.get(
    '/mcp/api/v1/status',
    limiter,
    requireAdminSession(RED, 'api'),
    (req: AuthenticatedRequest, res: Response) => {
      res.json(buildStatus(RED, req));
    }
  );

  // Documentation only — no admin session required.
  RED.httpAdmin.get('/mcp/api/v1/openapi.yaml', limiter, openApiYamlHandler());

  // User Settings / editor tab — admin session; PUT requires *.
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
    requireAiFeatures(RED),
    requireAdminReadOrAccessLink(RED, token => services.linkStore.validate(token)),
  ];

  RED.httpAdmin.get('/mcp/api/v1/flows', ...sharedRead, listFlowsHandler(services.flowAdapter));
  RED.httpAdmin.get('/mcp/api/v1/flows/:id', ...sharedRead, getFlowHandler(services.flowAdapter));

  RED.httpAdmin.get(
    '/mcp/api/v1/proposals',
    ...sharedRead,
    listProposalsHandler(services.proposalStore)
  );
  RED.httpAdmin.get(
    '/mcp/api/v1/proposals/:id',
    ...sharedRead,
    getProposalHandler(services.proposalStore)
  );

  RED.httpAdmin.post(
    '/mcp/api/v1/proposals',
    limiter,
    requireAccessLink(RED, services.linkStore),
    createProposalHandler(services.proposalStore, services.auditLog, services.flowAdapter)
  );

  const mcpRpcGuards = [limiter, requireAccessLink(RED, services.linkStore)];
  RED.httpAdmin.post('/mcp/rpc', ...mcpRpcGuards, mcpRpcPostHandler(RED, services));
  RED.httpAdmin.get('/mcp/rpc', ...mcpRpcGuards, mcpRpcMethodNotAllowed);
  RED.httpAdmin.delete('/mcp/rpc', ...mcpRpcGuards, mcpRpcMethodNotAllowed);

  RED.httpAdmin.post(
    '/mcp/api/v1/proposals/:id/approve',
    ...linkGuards,
    approveProposalHandler(services.proposalService)
  );
  RED.httpAdmin.post(
    '/mcp/api/v1/proposals/:id/reject',
    ...linkGuards,
    rejectProposalHandler(services.proposalService)
  );

  RED.httpAdmin.get(
    '/mcp/api/v1/logs',
    limiter,
    requireAdminSession(RED, 'api'),
    requireAiFeatures(RED),
    listLogsHandler(services.auditLog)
  );

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
