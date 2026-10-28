/**
 * Express error middleware: JSON (or JSON-RPC) responses for parse/size errors.
 * Never leak HTML stack traces on /mcp* routes.
 *
 * Must be attached to the Express app that runs body-parser (the editor-api
 * parent), not only the nested runtime.adminApp given to plugins.
 */

import type { ErrorRequestHandler, Express, NextFunction, Request, Response } from 'express';

import { MAX_PROPOSAL_JSON_BYTES } from '../storage/trusted-write.js';

import { httpAdminAppsForMcpErrors } from './http-admin-host.js';
import { internalErrorBody } from './route-errors.js';
import type { NodeRedPluginAPI } from './types.js';

const ATTACHED = Symbol.for('com55.ai-access.mcpJsonErrorHandler');

/**
 * JSON-RPC endpoints: `<root>/mcp/rpc` and its alias `<root>/mcp`. The handler runs
 * on the plugin app (paths relative to httpAdminRoot) and on the parent app (paths
 * include httpAdminRoot), so both forms are anchored.
 */
function mcpRpcMatcher(httpAdminRoot?: string): (path: string) => boolean {
  let root = httpAdminRoot ?? '/';
  while (root.endsWith('/')) {
    root = root.slice(0, -1);
  }
  const targets = new Set<string>();
  for (const base of root ? ['', root] : ['']) {
    for (const p of ['/mcp', '/mcp/rpc']) {
      targets.add(base + p);
      targets.add(`${base + p}/`);
    }
  }
  return path => targets.has(path);
}

function isMcpPath(path: string): boolean {
  return path.includes('/mcp');
}

function requestPath(req: Request): string {
  return req.path || req.url || req.originalUrl || '';
}

function isJsonParseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { type?: string; status?: number; statusCode?: number; body?: unknown };
  if (e.type === 'entity.parse.failed') {
    return true;
  }
  // body-parser / Express JSON SyntaxError
  if (err instanceof SyntaxError) {
    return true;
  }
  const message = typeof (err as Error).message === 'string' ? (err as Error).message : '';
  return /JSON/i.test(message) && (e.status === 400 || e.statusCode === 400);
}

function isPayloadTooLarge(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { type?: string; status?: number; statusCode?: number; message?: string };
  return (
    e.type === 'entity.too.large' ||
    e.status === 413 ||
    e.statusCode === 413 ||
    e.message === 'request entity too large'
  );
}

/**
 * Must be registered with `app.use` so Express treats it as error middleware
 * (4-arg signature). Safe to register on both plugin and parent httpAdmin.
 */
export function mcpJsonErrorHandler(httpAdminRoot?: string): ErrorRequestHandler {
  const isMcpRpcPath = mcpRpcMatcher(httpAdminRoot);
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const path = requestPath(req);

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
        code: 'payload_too_large',
      });
      return;
    }

    // Last-resort safety net: never let an uncaught /mcp* error become an HTML
    // stack page or an unhandled rejection that can crash Node-RED.
    if (isMcpPath(path)) {
      if (isMcpRpcPath(path)) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: internalErrorBody(err).error,
            data: { code: 'internal_error' },
          },
          id: null,
        });
        return;
      }
      res.status(500).json(internalErrorBody(err));
      return;
    }

    next(err);
  };
}

function attachOnce(app: Express, httpAdminRoot?: string): void {
  const marked = app as Express & { [ATTACHED]?: boolean };
  if (marked[ATTACHED]) {
    return;
  }
  marked[ATTACHED] = true;
  app.use(mcpJsonErrorHandler(httpAdminRoot));
}

/**
 * Attach /mcp JSON error handling to the plugin httpAdmin and, when present,
 * the parent editor-api app that owns body-parser.
 */
export function attachMcpJsonErrorHandlers(RED: NodeRedPluginAPI): void {
  for (const app of httpAdminAppsForMcpErrors(RED)) {
    attachOnce(app, RED.settings.httpAdminRoot);
  }
}
