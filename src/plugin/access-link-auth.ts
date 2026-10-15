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

export const ACCESS_LINK_WWW_AUTHENTICATE = 'Bearer realm="node-red-ai-access", charset="UTF-8"';

export const ACCESS_LINK_MISSING_CODE = 'access_link_missing' as const;
export const ACCESS_LINK_INVALID_CODE = 'access_link_invalid' as const;

function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function sendUnauthorized(
  res: Response,
  message: string,
  code: typeof ACCESS_LINK_MISSING_CODE | typeof ACCESS_LINK_INVALID_CODE
): void {
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

    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      sendUnauthorized(res, ACCESS_LINK_MISSING_MESSAGE, ACCESS_LINK_MISSING_CODE);
      return;
    }

    const link = store.validate(token);
    if (!link) {
      sendUnauthorized(res, ACCESS_LINK_INVALID_MESSAGE, ACCESS_LINK_INVALID_CODE);
      return;
    }

    req.accessLink = link;
    next();
  };
}
