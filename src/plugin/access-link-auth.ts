/**
 * Bearer access-link middleware for AI-facing routes.
 */

import type { NextFunction, Request, Response } from 'express';

import type { AccessLinkKind, AccessLinkStore } from '../access/link-store.js';

import { absolutizePath } from './access-path.js';
import { areAiFeaturesEnabled } from './settings.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

export const ACCESS_LINK_INVALID_MESSAGE =
  'Access link is invalid, revoked, or no longer available (it may have expired, or Node-RED may have restarted). Ask the user for a new access link.';

export const ACCESS_LINK_EXPIRED_MESSAGE =
  'Access link token has expired. Ask the user for a new access link.';

export const ACCESS_LINK_MISSING_MESSAGE =
  'Access link Bearer token is missing. Ask the user for a new access link and send Authorization: Bearer <token>.';

export const ACCESS_LINK_BEARER_REQUIRED_MESSAGE =
  'Authorization must use the Bearer scheme (Authorization: Bearer <access-link-token>), not Basic. Ask the user for a new access link.';

export const ACCESS_LINK_WWW_AUTHENTICATE = 'Bearer realm="node-red-ai-access", charset="UTF-8"';

export const ACCESS_LINK_MISSING_CODE = 'access_link_missing' as const;
export const ACCESS_LINK_INVALID_CODE = 'access_link_invalid' as const;
export const ACCESS_LINK_EXPIRED_CODE = 'token_expired' as const;
export const ACCESS_LINK_BEARER_REQUIRED_CODE = 'bearer_scheme_required' as const;
export const WRONG_TOKEN_KIND_CODE = 'wrong_token_kind' as const;

type AccessLinkAuthCode =
  | typeof ACCESS_LINK_MISSING_CODE
  | typeof ACCESS_LINK_INVALID_CODE
  | typeof ACCESS_LINK_EXPIRED_CODE
  | typeof ACCESS_LINK_BEARER_REQUIRED_CODE;

type AuthHeaderParse =
  { kind: 'missing' } | { kind: 'basic' } | { kind: 'other' } | { kind: 'bearer'; token: string };

function parseAuthorizationHeader(authorization: string | undefined): AuthHeaderParse {
  if (!authorization || authorization.trim().length === 0) {
    return { kind: 'missing' };
  }
  const trimmed = authorization.trim();
  if (/^Basic\s+/i.test(trimmed)) {
    return { kind: 'basic' };
  }
  const match = /^Bearer\s+(\S+)$/i.exec(trimmed);
  if (match?.[1]) {
    return { kind: 'bearer', token: match[1] };
  }
  return { kind: 'other' };
}

function sendUnauthorized(
  res: Response,
  message: string,
  code: AccessLinkAuthCode,
  hint?: string
): void {
  res.setHeader('WWW-Authenticate', ACCESS_LINK_WWW_AUTHENTICATE);
  res.status(401).json({ error: message, code, ...(hint ? { hint } : {}) });
}

/** Admin path of the `/mcp` page's Access links section (respects httpAdminRoot). */
export function accessLinksPagePath(httpAdminRoot: string | undefined): string {
  let root = httpAdminRoot ?? '';
  while (root.endsWith('/')) {
    root = root.slice(0, -1);
  }
  return `${root}/mcp#links`;
}

/**
 * `401 token_expired` body: when it expired and where the user creates a new link.
 */
export function tokenExpiredBody(
  req: Request,
  httpAdminRoot: string | undefined,
  expiredAt: string | undefined,
  hint?: string
): Record<string, unknown> {
  const accessLinksUrl = absolutizePath(req, accessLinksPagePath(httpAdminRoot));
  return {
    error: ACCESS_LINK_EXPIRED_MESSAGE,
    code: ACCESS_LINK_EXPIRED_CODE,
    ...(expiredAt ? { expiredAt } : {}),
    accessLinksUrl,
    hint:
      hint ??
      `Ask the user to create a new access link in Node-RED on the /mcp page → Access links (${accessLinksUrl}).`,
  };
}

/** Send `401 token_expired` with `WWW-Authenticate`. */
export function sendTokenExpired(
  req: Request,
  res: Response,
  httpAdminRoot: string | undefined,
  expiredAt: string | undefined,
  hint?: string
): void {
  res.setHeader('WWW-Authenticate', ACCESS_LINK_WWW_AUTHENTICATE);
  res.status(401).json(tokenExpiredBody(req, httpAdminRoot, expiredAt, hint));
}

/** Bearer (REST/MCP) truncated-token hint — never mention GET-link URL paths. */
function truncatedBearerHint(token: string): string | undefined {
  if (token.length < 24 || (token.startsWith('aia_') && token.length < 40)) {
    return 'The token may be truncated — ask the user for the full access-link token.';
  }
  return undefined;
}

/** Where owners mint tokens — include in wrong_token_kind hints. */
export const ACCESS_LINKS_MINT_HINT =
  'ask the owner: Node-RED /mcp → Access links → create kind=rest/mcp (or get_link)';

/**
 * Ready-made sentence AIs can show the human when the token kind is wrong.
 */
export function whatToTellUserWrongTokenKind(expectedKind: AccessLinkKind): string {
  if (expectedKind === 'get_link') {
    return (
      'Please open Node-RED → /mcp → Access links and create a get_link access URL, ' +
      'then send me that /mcp/a/<token> link.'
    );
  }
  return (
    `Please open Node-RED → /mcp → Access links and create a kind=${expectedKind} token, ` +
    'then send me the Bearer token (not a get_link path URL).'
  );
}

export function wrongTokenKindHint(
  expectedKind: AccessLinkKind,
  actualKind: AccessLinkKind
): string {
  const mint = ACCESS_LINKS_MINT_HINT;
  if (expectedKind === 'get_link') {
    return (
      `This URL requires a get_link token. This token is kind=${actualKind} — ${mint} ` +
      `for a get_link access URL (/mcp/a/<token>/…). What to tell the user: ${whatToTellUserWrongTokenKind('get_link')}`
    );
  }
  if (expectedKind === 'rest') {
    return (
      `This REST endpoint requires a rest token. This token is kind=${actualKind} — ${mint}. ` +
      `What to tell the user: ${whatToTellUserWrongTokenKind('rest')}`
    );
  }
  return (
    `This MCP endpoint requires an mcp token. This token is kind=${actualKind} — ${mint}. ` +
    `What to tell the user: ${whatToTellUserWrongTokenKind('mcp')}`
  );
}

/**
 * Reject a valid token that was minted for a different surface.
 * Uses 403 (authenticated, wrong kind for this route).
 */
export function sendWrongTokenKind(
  res: Response,
  expectedKind: AccessLinkKind,
  actualKind: AccessLinkKind
): void {
  // Authenticated but wrong surface — still advertise Bearer so clients retry
  // with a token of the expected kind.
  res.setHeader('WWW-Authenticate', ACCESS_LINK_WWW_AUTHENTICATE);
  res.status(403).json({
    error: `Access link kind mismatch: expected ${expectedKind}, got ${actualKind}`,
    code: WRONG_TOKEN_KIND_CODE,
    expectedKind,
    actualKind,
    hint: wrongTokenKindHint(expectedKind, actualKind),
    tellUser: whatToTellUserWrongTokenKind(expectedKind),
  });
}

/**
 * Authenticate AI clients with an access-link Bearer token of the expected kind.
 * Always rejects when AI features are disabled.
 */
export function requireAccessLink(
  RED: NodeRedPluginAPI,
  store: AccessLinkStore,
  expectedKind: AccessLinkKind
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

    const parsed = parseAuthorizationHeader(req.headers.authorization);
    if (parsed.kind === 'basic') {
      sendUnauthorized(res, ACCESS_LINK_BEARER_REQUIRED_MESSAGE, ACCESS_LINK_BEARER_REQUIRED_CODE);
      return;
    }
    if (parsed.kind === 'missing' || parsed.kind === 'other') {
      sendUnauthorized(res, ACCESS_LINK_MISSING_MESSAGE, ACCESS_LINK_MISSING_CODE);
      return;
    }

    const result = store.validateResult(parsed.token);
    if (result.status === 'expired') {
      sendTokenExpired(req, res, RED.settings.httpAdminRoot, result.expiresAt);
      return;
    }
    if (result.status !== 'active') {
      sendUnauthorized(
        res,
        ACCESS_LINK_INVALID_MESSAGE,
        ACCESS_LINK_INVALID_CODE,
        truncatedBearerHint(parsed.token)
      );
      return;
    }

    if (result.link.kind !== expectedKind) {
      sendWrongTokenKind(res, expectedKind, result.link.kind);
      return;
    }

    req.accessLink = result.link;
    next();
  };
}
