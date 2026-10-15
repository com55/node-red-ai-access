/**
 * Node-RED plugin entry for @com55/node-red-ai-access.
 *
 * Registers GET /mcp (admin page) and GET /mcp/api/v1/status.
 * Standalone MCP server entry (src/index.ts) is unchanged.
 */

import type { Response } from 'express';

import { requireAdminSession } from './auth.js';
import { renderMcpPage } from './page.js';
import { createAiAccessRateLimiter } from './rate-limit.js';
import { buildStatus } from './status.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

export type {
  AiAccessCapabilities,
  AiAccessPermission,
  AiAccessSettings,
  AiAccessStatus,
  NodeRedPluginAPI,
} from './types.js';

export { getStorageDir } from './storage.js';
export { areAiFeaturesEnabled, isAdminAuthEnabled, resolveAiAccessSettings } from './settings.js';

const PLUGIN_ID = 'com55-ai-access';

function registerRoutes(RED: NodeRedPluginAPI): void {
  const limiter = createAiAccessRateLimiter();

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
