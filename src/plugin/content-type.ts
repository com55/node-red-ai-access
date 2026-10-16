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
