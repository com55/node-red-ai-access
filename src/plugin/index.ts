/**
 * Node-RED plugin entry for @com55/node-red-ai-access.
 *
 * Registers /mcp admin page, access links, proposals, flows, and logs APIs.
 * Standalone MCP server entry (src/index.ts) is unchanged.
 */

import type { Response } from 'express';

import { requireAccessLink } from './access-link-auth.js';
import {
  requireAdminReadOrAccessLink,
  requireAdminSession,
  requireAiFeatures,
  requireStarPermission,
} from './auth.js';
import { getFlowHandler, listFlowsHandler } from './flows-routes.js';
import {
  createConfiguredLinkStore,
  createLinkHandler,
  listLinksHandler,
  revokeLinkHandler,
} from './links.js';
import { listLogsHandler } from './logs-routes.js';
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
export { ACCESS_LINK_INVALID_MESSAGE, requireAccessLink } from './access-link-auth.js';
export { getStorageDir } from './storage.js';
export { areAiFeaturesEnabled, isAdminAuthEnabled, resolveAiAccessSettings } from './settings.js';
export { createPluginServices } from './services.js';

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

  RED.httpAdmin.get(
    '/mcp',
    limiter,
    requireAdminSession(RED, 'page'),
    (req: AuthenticatedRequest, res: Response) => {
      const status = buildStatus(RED, req);
      res.type('html').status(200).send(renderMcpPage(status));
    }
  );

  RED.httpAdmin.get(
    '/mcp/api/v1/status',
    limiter,
    requireAdminSession(RED, 'api'),
    (req: AuthenticatedRequest, res: Response) => {
      res.json(buildStatus(RED, req));
    }
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
    createProposalHandler(services.proposalStore, services.auditLog)
  );

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
