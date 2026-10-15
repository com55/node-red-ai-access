/**
 * Bearer access-link middleware for future AI-facing routes.
 */

import type { NextFunction, Response } from 'express';

import type { AccessLinkStore } from '../access/link-store.js';

import { areAiFeaturesEnabled } from './settings.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

export const ACCESS_LINK_INVALID_MESSAGE =
  'Access link is invalid, expired, revoked, or no longer available after a restart. Ask the user for a new access link.';

function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
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
      });
      return;
    }

    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({ error: ACCESS_LINK_INVALID_MESSAGE });
      return;
    }

    const link = store.validate(token);
    if (!link) {
      res.status(401).json({ error: ACCESS_LINK_INVALID_MESSAGE });
      return;
    }

    req.accessLink = link;
    next();
  };
}
