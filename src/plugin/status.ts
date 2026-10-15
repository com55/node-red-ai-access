/**
 * Build the `/mcp/api/v1/status` payload.
 */

import { describeAccess } from './auth.js';
import { getStorageDir } from './storage.js';
import type { AiAccessStatus, AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

/** Injected by tsup / vitest define. */
declare const __AI_ACCESS_VERSION__: string | undefined;

let cachedVersion: string | undefined;

function readPackageVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  if (typeof __AI_ACCESS_VERSION__ === 'string' && __AI_ACCESS_VERSION__.length > 0) {
    cachedVersion = __AI_ACCESS_VERSION__;
    return cachedVersion;
  }

  cachedVersion = '0.0.0';
  return cachedVersion;
}

export function buildStatus(RED: NodeRedPluginAPI, req: AuthenticatedRequest): AiAccessStatus {
  const access = describeAccess(RED, req);
  return {
    ok: true,
    version: readPackageVersion(),
    adminAuthEnabled: access.adminAuthEnabled,
    aiFeaturesEnabled: access.aiFeaturesEnabled,
    allowWithoutAdminAuth: access.allowWithoutAdminAuth,
    permission: access.permission,
    capabilities: access.capabilities,
    storageDir: getStorageDir(RED.settings),
  };
}
