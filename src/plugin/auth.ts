/**
 * Auth gates for `/mcp` and `/mcp/api/v1/*`.
 */

import type { NextFunction, Response } from 'express';

import {
  ACCESS_LINK_INVALID_CODE,
  ACCESS_LINK_INVALID_MESSAGE,
  ACCESS_LINK_MISSING_CODE,
  ACCESS_LINK_MISSING_MESSAGE,
  ACCESS_LINK_WWW_AUTHENTICATE,
} from './access-link-auth.js';
import { areAiFeaturesEnabled, isAdminAuthEnabled, resolveAiAccessSettings } from './settings.js';
import type {
  AccessLinkAuthInfo,
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
 * `RED.auth.needsPermission` uses passport; when all strategies fail it sends
 * plain-text `Unauthorized` via `res.end` and never calls next. For API mode,
 * intercept that 401 and rewrite it as JSON with a stable `code`.
 */
function interceptNeedsPermissionUnauthorized(
  res: Response,
  body: { error: string; code: string } = {
    error: 'Authentication required',
    code: 'auth_required',
  },
  wwwAuthenticate?: string
): () => void {
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => unknown;
  let active = true;

  res.end = ((...args: unknown[]) => {
    if (active && res.statusCode === 401 && !res.headersSent) {
      active = false;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (wwwAuthenticate) {
        res.setHeader('WWW-Authenticate', wwwAuthenticate);
      }
      return originalEnd(JSON.stringify(body));
    }
    return originalEnd(...args);
  }) as typeof res.end;

  return () => {
    active = false;
    res.end = originalEnd as typeof res.end;
  };
}

/**
 * Require a logged-in admin user when adminAuth is enabled.
 * Unauthenticated page hits redirect to httpAdminRoot (editor login).
 * Unauthenticated API hits return 401 JSON `{ code: 'auth_required' }`.
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

    const restoreEnd = mode === 'api' ? interceptNeedsPermissionUnauthorized(res) : null;

    RED.auth.needsPermission(permissionNeeded)(req, res, (err?: unknown) => {
      restoreEnd?.();
      if (err) {
        next(err as Error);
        return;
      }

      if (!req.user) {
        if (mode === 'page') {
          res.redirect(normalizeHttpAdminRoot(RED.settings.httpAdminRoot));
          return;
        }
        res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
        return;
      }

      const permission = resolvePermission(req);
      if (!permission) {
        res
          .status(401)
          .json({ error: 'Insufficient permissions', code: 'insufficient_permissions' });
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
        code: 'ai_features_disabled',
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
      res
        .status(403)
        .json({ error: 'AI Access features are disabled', code: 'ai_features_disabled' });
      return;
    }

    const permission = resolvePermission(req);
    if (permission !== '*') {
      res.status(403).json({
        error: 'Full admin permission (*) is required for this action',
        code: 'insufficient_permissions',
      });
      return;
    }

    next();
  };
}

/** Access-link tokens are minted with an `aia_` prefix (see AccessLinkStore). */
function looksLikeAccessLinkToken(token: string): boolean {
  return token.startsWith('aia_');
}

/**
 * Treat as a (failed) access-link attempt rather than an editor session token:
 * - `aia_…` (minted access-link prefix)
 * - short/garbled tokens (e.g. `bogus`, truncated URL fragments)
 *
 * Longer opaque tokens (Node-RED editor Bearer from localStorage) and JWTs
 * must fall through to admin session auth.
 */
function looksLikeFailedAccessLinkAttempt(token: string): boolean {
  if (looksLikeAccessLinkToken(token)) {
    return true;
  }
  // Short / truncated garbage — not a plausible editor session token.
  return token.length < 24;
}

function truncatedTokenHint(token: string): string | undefined {
  if (token.length < 24 || (token.startsWith('aia_') && token.length < 40)) {
    return 'The access-link URL may be truncated — ask the user for the full /mcp/a/<token> link.';
  }
  return undefined;
}

export type AccessLinkValidator = (token: string) => AccessLinkAuthInfo | null;

function continueAsAdminSession(
  RED: NodeRedPluginAPI,
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
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
      res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
      return;
    }
    next();
  });
}

/**
 * Like continueAsAdminSession, but when admin auth fails, return
 * `access_link_missing` (with Bearer WWW-Authenticate for AI clients) instead
 * of passport's `auth_required` / realm="Users". Successful admin sessions
 * (cookie or editor Bearer) still proceed.
 */
function continueAsAdminSessionOrAccessLinkMissing(
  RED: NodeRedPluginAPI,
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!isAdminAuthEnabled(RED.settings)) {
    next();
    return;
  }

  const accessLinkMissingBody = {
    error: ACCESS_LINK_MISSING_MESSAGE,
    code: ACCESS_LINK_MISSING_CODE,
  };

  // Do not go through requireAdminSession — its interceptor would rewrite to
  // auth_required / leave passport's realm="Users".
  const restoreEnd = interceptNeedsPermissionUnauthorized(
    res,
    accessLinkMissingBody,
    ACCESS_LINK_WWW_AUTHENTICATE
  );

  RED.auth.needsPermission('read')(req, res, (err?: unknown) => {
    restoreEnd();
    if (err) {
      next(err as Error);
      return;
    }
    if (!req.user || !resolvePermission(req)) {
      res.setHeader('WWW-Authenticate', ACCESS_LINK_WWW_AUTHENTICATE);
      res.status(401).json(accessLinkMissingBody);
      return;
    }
    next();
  });
}

function tryAccessLinkBearer(
  req: AuthenticatedRequest,
  res: Response,
  validateAccessLink: AccessLinkValidator
): 'ok' | 'invalid' | 'continue' {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !/^Bearer\s+\S+/i.test(authHeader.trim())) {
    return 'continue';
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  const token = match?.[1];
  if (!token) {
    return 'continue';
  }
  const link = validateAccessLink(token);
  if (link) {
    req.accessLink = link;
    return 'ok';
  }
  if (looksLikeFailedAccessLinkAttempt(token)) {
    res.setHeader('WWW-Authenticate', ACCESS_LINK_WWW_AUTHENTICATE);
    const hint = truncatedTokenHint(token);
    res.status(401).json({
      error: ACCESS_LINK_INVALID_MESSAGE,
      code: ACCESS_LINK_INVALID_CODE,
      ...(hint ? { hint } : {}),
    });
    return 'invalid';
  }
  return 'continue';
}

/**
 * Accept either a valid access-link Bearer token or an admin session with at
 * least `read` permission. Used for shared read surfaces (flows, proposals).
 *
 * Editor admin Bearer tokens (from localStorage) must fall through to
 * `requireAdminSession` — they are not access-link tokens. Unknown `aia_…`
 * tokens and short/garbled Bearers return `access_link_invalid`; longer
 * opaque editor tokens continue to admin auth.
 *
 * When no admin session is present, failed auth returns `access_link_missing`
 * (not passport `auth_required` / realm="Users") so plain HTTP AI clients get
 * actionable guidance.
 */
export function requireAdminReadOrAccessLink(
  RED: NodeRedPluginAPI,
  validateAccessLink: AccessLinkValidator
) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!areAiFeaturesEnabled(RED.settings)) {
      res.status(403).json({
        error:
          'AI Access features are disabled. Enable adminAuth, or set aiAccess.allowWithoutAdminAuth to true for local-only use.',
        code: 'ai_features_disabled',
      });
      return;
    }

    const access = tryAccessLinkBearer(req, res, validateAccessLink);
    if (access === 'ok') {
      next();
      return;
    }
    if (access === 'invalid') {
      return;
    }

    // Editor / other Bearer, cookie session, or missing token → try admin;
    // on failure prefer access_link_missing for AI clients.
    continueAsAdminSessionOrAccessLinkMissing(RED, req, res, next);
  };
}

/**
 * Admin session (page bootstrap) or a valid access-link Bearer.
 * Missing/invalid non-link tokens keep `auth_required` for the /mcp UI.
 * Unknown `aia_` tokens return `access_link_invalid`.
 */
export function requireAdminSessionOrAccessLink(
  RED: NodeRedPluginAPI,
  validateAccessLink: AccessLinkValidator
) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const access = tryAccessLinkBearer(req, res, validateAccessLink);
    if (access === 'ok') {
      next();
      return;
    }
    if (access === 'invalid') {
      return;
    }
    continueAsAdminSession(RED, req, res, next);
  };
}
