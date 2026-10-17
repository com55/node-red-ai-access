/**
 * Build the `/mcp/api/v1/status` payload.
 */

import { describeAccess, mcpApiBase, mcpRpcPath } from './auth.js';
import { packageVersion } from './package-version.js';
import { resolveAiAccessSettings } from './settings.js';
import { getStorageDir } from './storage.js';
import type {
  AccessLinkKind,
  AiAccessStatus,
  AiAccessStatusCallerBaseUrls,
  AuthenticatedRequest,
  NodeRedPluginAPI,
} from './types.js';

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

/** Whole seconds until ISO expiry (rounded up; never negative). */
export function secondsRemainingUntil(expiresAt: string, nowMs = Date.now()): number {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return 0;
  }
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}

/**
 * Whole minutes until ISO expiry, rounded **up** so a still-valid token never
 * reports 0 (e.g. 30s left → 1). Never negative.
 */
export function minutesRemainingUntil(expiresAt: string, nowMs = Date.now()): number {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return 0;
  }
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 60_000));
}

/**
 * Only include baseUrls this token kind can call.
 * get_link uses path URLs (not listed here); rest → api/openapi/openapiJson/discovery; mcp → rpc (+ discovery).
 */
export function baseUrlsForTokenKind(
  kind: AccessLinkKind,
  httpAdminRoot: string | undefined
): Partial<AiAccessStatusCallerBaseUrls> {
  const api = mcpApiBase(httpAdminRoot);
  const rpc = mcpRpcPath(httpAdminRoot);
  const openapi = `${api}/openapi.yaml`;
  const openapiJson = `${api}/openapi.json`;
  if (kind === 'rest') {
    return { api, openapi, openapiJson, discovery: api };
  }
  if (kind === 'mcp') {
    return { rpc, discovery: api };
  }
  // get_link: path tokens are not Bearer bases — omit REST/MCP URLs.
  return { discovery: api };
}

export function buildStatus(RED: NodeRedPluginAPI, req: AuthenticatedRequest): AiAccessStatus {
  const access = describeAccess(RED, req);
  const aiSettings = resolveAiAccessSettings(RED.settings);

  // Access-link callers are not admin sessions: permission stays null; caller
  // identifies the AI token so clients do not treat null as "logged out".
  if (req.accessLink) {
    const nowMs = Date.now();
    return {
      ok: true,
      version: readPackageVersion(),
      adminAuthEnabled: access.adminAuthEnabled,
      aiAccessEnabled: aiSettings.enabled,
      aiFeaturesEnabled: access.aiFeaturesEnabled,
      allowWithoutAdminAuth: access.allowWithoutAdminAuth,
      permission: null,
      capabilities: { view: true, manageLinks: false, approveProposals: false },
      defaultLinkTtlSeconds: aiSettings.defaultLinkTtlSeconds,
      maxActiveLinks: aiSettings.maxActiveLinks,
      defaultDeploymentType: aiSettings.defaultDeploymentType,
      caller: {
        kind: 'access-link',
        linkId: req.accessLink.id,
        tokenKind: req.accessLink.kind,
        ...(req.accessLink.label !== undefined ? { label: req.accessLink.label } : {}),
        expiresAt: req.accessLink.expiresAt,
        minutesRemaining: minutesRemainingUntil(req.accessLink.expiresAt, nowMs),
        secondsRemaining: secondsRemainingUntil(req.accessLink.expiresAt, nowMs),
        permissions: [...ACCESS_LINK_PERMISSIONS],
        baseUrls: baseUrlsForTokenKind(req.accessLink.kind, RED.settings.httpAdminRoot),
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
