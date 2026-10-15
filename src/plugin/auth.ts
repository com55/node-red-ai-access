/**
 * Auth gates for `/mcp` and `/mcp/api/v1/*`.
 */

import type { NextFunction, Response } from 'express';

import { areAiFeaturesEnabled, isAdminAuthEnabled, resolveAiAccessSettings } from './settings.js';
import type {
  AiAccessCapabilities,
  AiAccessPermission,
  AuthenticatedRequest,
  NodeRedPluginAPI,
} from './types.js';

export type AdminGateMode = 'page' | 'api';

function normalizeHttpAdminRoot(httpAdminRoot: string | undefined): string {
  if (!httpAdminRoot || httpAdminRoot === '/') {
    return '/';
  }
  return httpAdminRoot.endsWith('/') ? httpAdminRoot.slice(0, -1) : httpAdminRoot;
}

function scopesFromRequest(req: AuthenticatedRequest): string[] {
  const fromAuthInfo = req.authInfo?.scope;
  if (fromAuthInfo) {
    return Array.isArray(fromAuthInfo) ? fromAuthInfo : [fromAuthInfo];
  }

  const fromUser = req.user?.permissions;
  if (fromUser) {
    return Array.isArray(fromUser) ? fromUser : [fromUser];
  }

  return [];
}

export function resolvePermission(req: AuthenticatedRequest): AiAccessPermission | null {
  const scopes = scopesFromRequest(req);
  if (scopes.includes('*')) {
    return '*';
  }
  if (scopes.includes('read')) {
    return 'read';
  }
  return null;
}

export function capabilitiesFor(
  permission: AiAccessPermission | null,
  aiFeaturesEnabled: boolean
): AiAccessCapabilities {
  if (!aiFeaturesEnabled || !permission) {
    return { view: true, manageLinks: false, approveProposals: false };
  }
  if (permission === '*') {
    return { view: true, manageLinks: true, approveProposals: true };
  }
  return { view: true, manageLinks: false, approveProposals: false };
}

/**
 * Require a logged-in admin user when adminAuth is enabled.
 * Unauthenticated page hits redirect to httpAdminRoot (editor login).
 * Unauthenticated API hits return 401.
 *
 * When adminAuth is off, requests continue; AI feature enablement is enforced
 * separately via settings (see areAiFeaturesEnabled).
 */
export function requireAdminSession(RED: NodeRedPluginAPI, mode: AdminGateMode) {
  const permissionNeeded = 'read';

  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!isAdminAuthEnabled(RED.settings)) {
      next();
      return;
    }

    RED.auth.needsPermission(permissionNeeded)(req, res, (err?: unknown) => {
      if (err) {
        next(err as Error);
        return;
      }

      if (!req.user) {
        if (mode === 'page') {
          res.redirect(normalizeHttpAdminRoot(RED.settings.httpAdminRoot));
          return;
        }
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const permission = resolvePermission(req);
      if (!permission) {
        res.status(401).json({ error: 'Insufficient permissions' });
        return;
      }

      next();
    });
  };
}

export function describeAccess(RED: NodeRedPluginAPI, req: AuthenticatedRequest) {
  const adminAuthEnabled = isAdminAuthEnabled(RED.settings);
  const aiSettings = resolveAiAccessSettings(RED.settings);
  const aiFeaturesEnabled = areAiFeaturesEnabled(RED.settings);

  let permission: AiAccessPermission | null = null;
  if (adminAuthEnabled) {
    permission = resolvePermission(req);
  } else if (aiFeaturesEnabled) {
    // Local-only opt-in: treat the session as full access.
    permission = '*';
  }

  return {
    adminAuthEnabled,
    aiFeaturesEnabled,
    allowWithoutAdminAuth: aiSettings.allowWithoutAdminAuth,
    permission,
    capabilities: capabilitiesFor(permission, aiFeaturesEnabled),
  };
}
