/**
 * Bearer access-link middleware for AI-facing routes.
 */

import type { NextFunction, Response } from 'express';

import type { AccessLinkStore } from '../access/link-store.js';

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

function sendUnauthorized(res: Response, message: string, code: AccessLinkAuthCode): void {
  res.setHeader('WWW-Authenticate', ACCESS_LINK_WWW_AUTHENTICATE);
  res.status(401).json({ error: message, code });
}

/**
 * Authenticate AI clients with an access-link Bearer token.
 * Always rejects when AI features are disabled.
 */
export function requireAccessLink(RED: NodeRedPluginAPI, store: AccessLinkStore) {
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
      sendUnauthorized(res, ACCESS_LINK_INVALID_MESSAGE, ACCESS_LINK_INVALID_CODE);
      return;
    }

    req.accessLink = link;
    next();
  };
}
