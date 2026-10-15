/**
 * Express error middleware: JSON (or JSON-RPC) responses for parse/size errors.
 * Never leak HTML stack traces on /mcp* routes.
 */

import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';

import { MAX_PROPOSAL_JSON_BYTES } from '../storage/trusted-write.js';

function isMcpRpcPath(path: string): boolean {
  return /\/mcp\/rpc\/?$/.test(path) || path.endsWith('/mcp/rpc');
}

function isMcpPath(path: string): boolean {
  return path.includes('/mcp');
}

function isJsonParseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { type?: string; status?: number; statusCode?: number; body?: unknown };
  if (e.type === 'entity.parse.failed') {
    return true;
  }
  return err instanceof SyntaxError && 'body' in err;
}

function isPayloadTooLarge(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { type?: string; status?: number; statusCode?: number };
  return e.type === 'entity.too.large' || e.status === 413 || e.statusCode === 413;
}

/**
 * Must be registered with `RED.httpAdmin.use` after routes so Express treats it
 * as error middleware (4-arg signature).
 */
export function mcpJsonErrorHandler(): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const path = req.path || req.url || '';

    if (isJsonParseError(err) && isMcpPath(path)) {
      if (isMcpRpcPath(path)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        });
        return;
      }
      res.status(400).json({ error: 'Invalid JSON body', code: 'invalid_json' });
      return;
    }

    if (isPayloadTooLarge(err) && isMcpPath(path)) {
      res.status(413).json({
        error: `Request body exceeds limit of ${MAX_PROPOSAL_JSON_BYTES} bytes`,
        code: 'storage_payload_too_large',
      });
      return;
    }

    next(err);
  };
}
