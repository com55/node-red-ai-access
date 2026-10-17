/**
 * Require JSON Content-Type on REST/MCP write routes (415 otherwise).
 */

import type { NextFunction, Request, Response } from 'express';

import { buildChannelError, type ErrorChannel } from './channel-errors.js';

function isJsonContentType(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === 'application/json' || mime.endsWith('+json');
}

function hasRequestBody(req: Request): boolean {
  const lengthHeader = req.headers['content-length'];
  if (typeof lengthHeader === 'string' && lengthHeader.length > 0) {
    const n = Number(lengthHeader);
    if (Number.isFinite(n) && n > 0) {
      return true;
    }
    if (n === 0) {
      return false;
    }
  }
  return req.headers['transfer-encoding'] !== undefined;
}

/**
 * Reject non-JSON Content-Type with 415.
 * Empty bodies with no Content-Type (e.g. bare POST approve) are allowed;
 * any declared non-JSON type, or a body without JSON type, is rejected.
 */
export function requireJsonContentType(channel: ErrorChannel = 'rest') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentType = req.headers['content-type'];
    if (isJsonContentType(contentType)) {
      next();
      return;
    }
    if (!contentType && !hasRequestBody(req)) {
      next();
      return;
    }
    const mapped = buildChannelError(channel, 'unsupported_media_type', { statusCode: 415 });
    res.status(mapped.statusCode).json(mapped.body);
  };
}

const TEXT_PLAIN = 'text/plain; charset=utf-8';

function formatParam(req: Request): string | undefined {
  const value = req.query?.format;
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}

/**
 * Negotiated Content-Type for a GET-link response whose real type is
 * `text/markdown` or `application/json`. Defaults to `text/plain` (some AI web
 * readers reject other types); the real type is used only when `?format=`
 * asks for it or `Accept` explicitly prefers it over text/plain — a bare
 * wildcard Accept yields text/plain.
 */
export function negotiateGetLinkContentType(req: Request, realType: string): string {
  const mime = realType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime === 'text/markdown') {
    return formatParam(req) === 'md' ||
      req.accepts(['text/plain', 'text/markdown']) === 'text/markdown'
      ? 'text/markdown; charset=utf-8'
      : TEXT_PLAIN;
  }
  if (mime === 'application/json') {
    return formatParam(req) === 'json' ||
      req.accepts(['text/plain', 'application/json']) === 'application/json'
      ? 'application/json; charset=utf-8'
      : TEXT_PLAIN;
  }
  return realType;
}

/**
 * GET-link channel middleware: rewrites `text/markdown` / `application/json`
 * Content-Type headers per {@link negotiateGetLinkContentType} and adds
 * `Vary: Accept`. Bodies and status codes are untouched.
 */
export function getLinkContentNegotiation() {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.vary('Accept');
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: number | string | readonly string[]) => {
      if (name.toLowerCase() === 'content-type' && typeof value === 'string') {
        return originalSetHeader(name, negotiateGetLinkContentType(req, value));
      }
      return originalSetHeader(name, value);
    }) as Response['setHeader'];
    next();
  };
}
