/**
 * Middleware for `/mcp/a/<token>…` — validate path token, no-store, rate limit.
 */

import type { NextFunction, Request, Response } from 'express';

import type { AccessLinkStore } from '../../access/link-store.js';
import {
  ACCESS_LINK_EXPIRED_CODE,
  ACCESS_LINK_EXPIRED_MESSAGE,
  ACCESS_LINK_INVALID_CODE,
  ACCESS_LINK_INVALID_MESSAGE,
  ACCESS_LINK_MISSING_CODE,
  ACCESS_LINK_MISSING_MESSAGE,
  sendWrongTokenKind,
} from '../access-link-auth.js';
import { MAX_GET_ACCESS_URL_BYTES, redactAccessLinkTokenInPath } from '../access-path.js';
import { createGetLinkRateLimiter } from '../rate-limit.js';
import { areAiFeaturesEnabled } from '../settings.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from '../types.js';

export { createGetLinkRateLimiter };

export function setNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

/** Never log raw access-link tokens from the path. */
export function redactTokenFromRequestUrl(req: Request): void {
  const original = req.originalUrl || req.url || '';
  const redacted = redactAccessLinkTokenInPath(original);
  if (redacted !== original) {
    // Express / debug loggers often read originalUrl; keep a safe copy.
    Object.defineProperty(req, 'originalUrl', {
      value: redacted,
      writable: true,
      configurable: true,
    });
    if (typeof req.url === 'string') {
      Object.defineProperty(req, 'url', {
        value: redactAccessLinkTokenInPath(req.url),
        writable: true,
        configurable: true,
      });
    }
  }
}

/**
 * Resolve `:token` from the path, validate the access link, attach
 * `req.accessLink`, set Cache-Control: no-store, and redact the token from
 * request URL fields used by loggers.
 */
export function requireGetLinkToken(RED: NodeRedPluginAPI, store: AccessLinkStore) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    setNoStore(res);
    // Capture URL length before redacting the token from logger-facing fields.
    const rawUrl = req.originalUrl || req.url || '';
    (req as AuthenticatedRequest & { getLinkUrlBytes?: number }).getLinkUrlBytes =
      Buffer.byteLength(rawUrl, 'utf8');
    redactTokenFromRequestUrl(req);

    if (!areAiFeaturesEnabled(RED.settings)) {
      res.status(403).json({
        error:
          'AI Access features are disabled. Enable adminAuth, or set aiAccess.allowWithoutAdminAuth to true for local-only use.',
        code: 'ai_features_disabled',
        hint: 'Ask the Node-RED owner to enable AI Access.',
      });
      return;
    }

    const raw = req.params.token;
    if (typeof raw !== 'string' || raw.length === 0) {
      res.status(401).json({
        error: ACCESS_LINK_MISSING_MESSAGE,
        code: ACCESS_LINK_MISSING_CODE,
        hint: 'Ask the user for a new self-contained access link URL.',
      });
      return;
    }

    let token = raw;
    try {
      token = decodeURIComponent(raw);
    } catch {
      // keep raw
    }

    const result = store.validateResult(token);
    if (result.status === 'expired') {
      res.status(401).json({
        error: ACCESS_LINK_EXPIRED_MESSAGE,
        code: ACCESS_LINK_EXPIRED_CODE,
        hint: 'Ask the user for a new self-contained access link URL.',
      });
      return;
    }
    if (result.status !== 'active') {
      const truncated =
        token.length < 24 || (token.startsWith('aia_') && token.length < 40)
          ? 'The access-link URL may be truncated — ask the user for the full /mcp/a/<token> link.'
          : 'Ask the user for a new self-contained access link URL (it may have expired, or Node-RED may have restarted).';
      res.status(401).json({
        error: ACCESS_LINK_INVALID_MESSAGE,
        code: ACCESS_LINK_INVALID_CODE,
        hint: truncated,
      });
      return;
    }

    if (result.link.kind !== 'get_link') {
      sendWrongTokenKind(res, 'get_link', result.link.kind);
      return;
    }

    req.accessLink = result.link;
    // Keep the raw token only for building docs URLs in this request; never audit it.
    (req as AuthenticatedRequest & { getLinkToken?: string }).getLinkToken = token;
    next();
  };
}

/** Reject when the request URL exceeds the GET soft cap. */
export function rejectOversizedGetUrl(req: AuthenticatedRequest, res: Response): boolean {
  const tracked = (req as AuthenticatedRequest & { getLinkUrlBytes?: number }).getLinkUrlBytes;
  const rawLen =
    typeof tracked === 'number'
      ? tracked
      : Buffer.byteLength(req.originalUrl || req.url || '', 'utf8');
  if (rawLen > MAX_GET_ACCESS_URL_BYTES) {
    setNoStore(res);
    res.status(414).json({
      error: `Request URL exceeds ${MAX_GET_ACCESS_URL_BYTES} bytes`,
      code: 'url_too_long',
      hint:
        'Use chunked drafts: GET …/draft/new then …/draft/<id>/append?seq=&data= then …/draft/<id>/submit?sha256=, ' +
        'or use POST /mcp/api/v1/proposals with Authorization: Bearer <token>.',
      limitBytes: MAX_GET_ACCESS_URL_BYTES,
    });
    return true;
  }
  return false;
}

export function jsonError(
  res: Response,
  statusCode: number,
  error: string,
  code: string,
  hint?: string,
  extra?: Record<string, unknown>
): void {
  setNoStore(res);
  res.status(statusCode).json({
    error,
    code,
    ...(hint ? { hint } : {}),
    ...extra,
  });
}

/**
 * JSON 404 for unmatched paths under `/mcp/a/*`.
 * Never echo the request path (it may contain the access-link token).
 */
export function getLinkNotFoundHandler() {
  return (req: Request, res: Response): void => {
    redactTokenFromRequestUrl(req);
    setNoStore(res);
    res.status(404).json({ error: 'Not found', code: 'not_found' });
  };
}

export const LINK_CREATE_NOT_SUPPORTED_CODE = 'link_create_not_supported' as const;

/**
 * Explicit rejection for any mint/list/revoke attempt under `/mcp/a/<token>/links`.
 * GET access links never create tokens — admin `POST /mcp/api/v1/links` only.
 */
export function getLinkMintNotSupportedHandler() {
  return (req: Request, res: Response): void => {
    redactTokenFromRequestUrl(req);
    setNoStore(res);
    res.status(405).json({
      error: 'GET access links cannot create tokens',
      code: LINK_CREATE_NOT_SUPPORTED_CODE,
      hint: 'Ask an admin with * permission to mint tokens via POST /mcp/api/v1/links on the /mcp Access links page. This get_link URL cannot create, list, or revoke tokens.',
    });
  };
}
