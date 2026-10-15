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

export function normalizeHttpAdminRoot(httpAdminRoot: string | undefined): string {
  if (!httpAdminRoot || httpAdminRoot === '/') {
    return '/';
  }
  return httpAdminRoot.endsWith('/') ? httpAdminRoot.slice(0, -1) : httpAdminRoot;
}

/** Absolute admin path for `/mcp/api/v1` (respects httpAdminRoot). */
export function mcpApiBase(httpAdminRoot: string | undefined): string {
  const root = normalizeHttpAdminRoot(httpAdminRoot);
  return root === '/' ? '/mcp/api/v1' : `${root}/mcp/api/v1`;
}

/** Absolute admin path for `/mcp/rpc` (respects httpAdminRoot). */
export function mcpRpcPath(httpAdminRoot: string | undefined): string {
  const root = normalizeHttpAdminRoot(httpAdminRoot);
  return root === '/' ? '/mcp/rpc' : `${root}/mcp/rpc`;
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

/**
 * Reject when AI features are disabled (no adminAuth and no local opt-in).
 */
export function requireAiFeatures(RED: NodeRedPluginAPI) {
  return (_req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!areAiFeaturesEnabled(RED.settings)) {
      res.status(403).json({
        error:
          'AI Access features are disabled. Enable adminAuth, or set aiAccess.allowWithoutAdminAuth to true for local-only use.',
      });
      return;
    }
    next();
  };
}

/**
 * Require full (`*`) permission for mutating admin actions (links, approvals).
 * Must run after requireAdminSession. Read-only users receive 403.
 */
export function requireStarPermission(RED: NodeRedPluginAPI) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!isAdminAuthEnabled(RED.settings)) {
      // Local-only opt-in already treated as full access by describeAccess.
      if (areAiFeaturesEnabled(RED.settings)) {
        next();
        return;
      }
      res.status(403).json({ error: 'AI Access features are disabled' });
      return;
    }

    const permission = resolvePermission(req);
    if (permission !== '*') {
      res.status(403).json({
        error: 'Full admin permission (*) is required for this action',
      });
      return;
    }

    next();
  };
}

/**
 * Accept either a valid access-link Bearer token or an admin session with at
 * least `read` permission. Used for shared read surfaces (flows, proposals).
 */
export function requireAdminReadOrAccessLink(
  RED: NodeRedPluginAPI,
  validateAccessLink: (token: string) => {
    id: string;
    label?: string;
    createdAt: string;
    expiresAt: string;
    createdBy?: string;
  } | null
) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!areAiFeaturesEnabled(RED.settings)) {
      res.status(403).json({
        error:
          'AI Access features are disabled. Enable adminAuth, or set aiAccess.allowWithoutAdminAuth to true for local-only use.',
      });
      return;
    }

    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && /^Bearer\s+\S+/i.test(authHeader.trim())) {
      const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
      const token = match?.[1];
      if (!token) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const link = validateAccessLink(token);
      if (!link) {
        res.status(401).json({
          error:
            'Access link is invalid, expired, revoked, or no longer available after a restart. Ask the user for a new access link.',
        });
        return;
      }
      req.accessLink = link;
      next();
      return;
    }

    requireAdminSession(RED, 'api')(req, res, (err?: unknown) => {
      if (err) {
        next(err as Error);
        return;
      }
      if (!isAdminAuthEnabled(RED.settings)) {
        next();
        return;
      }
      if (!resolvePermission(req)) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      next();
    });
  };
}
