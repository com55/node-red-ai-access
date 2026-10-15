/**
 * Build the `/mcp/api/v1/status` payload.
 */

import { describeAccess } from './auth.js';
import { resolveAiAccessSettings } from './settings.js';
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
  const aiSettings = resolveAiAccessSettings(RED.settings);

  // Access-link callers are not admin sessions: permission stays null; caller
  // identifies the AI token so clients do not treat null as "logged out".
  if (req.accessLink) {
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
