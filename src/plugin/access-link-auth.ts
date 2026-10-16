/**
 * Bearer access-link middleware for AI-facing routes.
 */

import type { NextFunction, Response } from 'express';

import type { AccessLinkKind, AccessLinkStore } from '../access/link-store.js';

import { areAiFeaturesEnabled } from './settings.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

export const ACCESS_LINK_INVALID_MESSAGE =
  'Access link is invalid, expired, revoked, or no longer available after a restart. Ask the user for a new access link.';

export const ACCESS_LINK_MISSING_MESSAGE =
  'Access link Bearer token is missing. Ask the user for a new access link and send Authorization: Bearer <token>.';

export const ACCESS_LINK_BEARER_REQUIRED_MESSAGE =
  'Authorization must use the Bearer scheme (Authorization: Bearer <access-link-token>), not Basic. Ask the user for a new access link.';

export const ACCESS_LINK_WWW_AUTHENTICATE = 'Bearer realm="node-red-ai-access", charset="UTF-8"';

export const ACCESS_LINK_MISSING_CODE = 'access_link_missing' as const;
export const ACCESS_LINK_INVALID_CODE = 'access_link_invalid' as const;
export const ACCESS_LINK_BEARER_REQUIRED_CODE = 'bearer_scheme_required' as const;
export const WRONG_TOKEN_KIND_CODE = 'wrong_token_kind' as const;

type AccessLinkAuthCode =
  | typeof ACCESS_LINK_MISSING_CODE
  | typeof ACCESS_LINK_INVALID_CODE
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

function truncatedBearerHint(token: string): string | undefined {
  if (token.length < 24 || (token.startsWith('aia_') && token.length < 40)) {
    return 'The access-link URL may be truncated — ask the user for the full /mcp/a/<token> link.';
  }
  return undefined;
}

export function wrongTokenKindHint(
  expectedKind: AccessLinkKind,
  actualKind: AccessLinkKind
): string {
  if (expectedKind === 'get_link') {
    return `This URL requires a get_link token. This token is kind=${actualKind} — ask the user for a get_link access URL (/mcp/a/<token>/…).`;
  }
  if (expectedKind === 'rest') {
    return `This REST endpoint requires a rest token. This token is kind=${actualKind} — ask the user for a REST Bearer token (kind=rest).`;
  }
  return `This MCP endpoint requires an mcp token. This token is kind=${actualKind} — ask the user for an MCP Bearer token (kind=mcp).`;
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
  res.status(403).json({
    error: `Access link kind mismatch: expected ${expectedKind}, got ${actualKind}`,
    code: WRONG_TOKEN_KIND_CODE,
    expectedKind,
    actualKind,
    hint: wrongTokenKindHint(expectedKind, actualKind),
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

    const link = store.validate(parsed.token);
    if (!link) {
      sendUnauthorized(
        res,
        ACCESS_LINK_INVALID_MESSAGE,
        ACCESS_LINK_INVALID_CODE,
        truncatedBearerHint(parsed.token)
      );
      return;
    }

    if (link.kind !== expectedKind) {
      sendWrongTokenKind(res, expectedKind, link.kind);
      return;
    }

    req.accessLink = link;
    next();
  };
}
