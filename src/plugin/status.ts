/**
 * Build the `/mcp/api/v1/status` payload.
 */

import { describeAccess, mcpApiBase, mcpRpcPath } from './auth.js';
import { packageVersion } from './package-version.js';
import { resolveAiAccessSettings } from './settings.js';
import { getStorageDir } from './storage.js';
import type { AiAccessStatus, AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

/** Fixed capabilities granted to a valid access-link Bearer. */
export const ACCESS_LINK_PERMISSIONS = [
  'status:read',
  'flows:read',
  'proposals:create',
  'proposals:read-own',
] as const;

function readPackageVersion(): string {
  return packageVersion();
}

export function buildStatus(RED: NodeRedPluginAPI, req: AuthenticatedRequest): AiAccessStatus {
  const access = describeAccess(RED, req);
  const aiSettings = resolveAiAccessSettings(RED.settings);

  // Access-link callers are not admin sessions: permission stays null; caller
  // identifies the AI token so clients do not treat null as "logged out".
  if (req.accessLink) {
    const api = mcpApiBase(RED.settings.httpAdminRoot);
    return {
      ok: true,
      version: readPackageVersion(),
      adminAuthEnabled: access.adminAuthEnabled,
      aiAccessEnabled: aiSettings.enabled,
      aiFeaturesEnabled: access.aiFeaturesEnabled,
      allowWithoutAdminAuth: access.allowWithoutAdminAuth,
      permission: null,
      capabilities: { view: true, manageLinks: false, approveProposals: false },
      storageDir: getStorageDir(RED.settings),
      defaultLinkTtlSeconds: aiSettings.defaultLinkTtlSeconds,
      maxActiveLinks: aiSettings.maxActiveLinks,
      defaultDeploymentType: aiSettings.defaultDeploymentType,
      caller: {
        kind: 'access-link',
        linkId: req.accessLink.id,
        ...(req.accessLink.label !== undefined ? { label: req.accessLink.label } : {}),
        expiresAt: req.accessLink.expiresAt,
        permissions: [...ACCESS_LINK_PERMISSIONS],
        baseUrls: {
          api,
          rpc: mcpRpcPath(RED.settings.httpAdminRoot),
          openapi: `${api}/openapi.yaml`,
          discovery: api,
        },
      },
    };
  }

  return {
    ok: true,
    version: readPackageVersion(),
    adminAuthEnabled: access.adminAuthEnabled,
    aiAccessEnabled: aiSettings.enabled,
    aiFeaturesEnabled: access.aiFeaturesEnabled,
    allowWithoutAdminAuth: access.allowWithoutAdminAuth,
    permission: access.permission,
    capabilities: access.capabilities,
    storageDir: getStorageDir(RED.settings),
    defaultLinkTtlSeconds: aiSettings.defaultLinkTtlSeconds,
    maxActiveLinks: aiSettings.maxActiveLinks,
    defaultDeploymentType: aiSettings.defaultDeploymentType,
    caller: {
      kind: 'admin',
      ...(access.permission ? { permission: access.permission } : {}),
    },
  };
}
