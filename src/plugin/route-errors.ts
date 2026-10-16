/**
 * Safe JSON error responses for plugin HTTP routes.
 * Never rethrow from route handlers — uncaught async errors can crash Node-RED.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { aiOpsErrorToHttp } from './ai-ops.js';

/** 500 JSON body used when a route fails unexpectedly. */
export function internalErrorBody(error?: unknown): {
  error: string;
  code: 'internal_error';
} {
  const message =
    error instanceof Error && error.message.trim() ? error.message : 'Internal server error';
  return { error: message, code: 'internal_error' };
}

export function sendInternalError(res: Response, error?: unknown): void {
  if (res.headersSent) {
    return;
  }
  res.status(500).json(internalErrorBody(error));
}

/**
 * Map known AI-ops errors to JSON; otherwise 500 internal_error.
 * Use in every route `catch` instead of rethrowing.
 */
export function sendCaughtRouteError(res: Response, error: unknown): void {
  if (res.headersSent) {
    return;
  }
  const mapped = aiOpsErrorToHttp(error);
  if (mapped) {
    res.status(mapped.statusCode).json(mapped.body);
    return;
  }
  sendInternalError(res, error);
}

/**
 * Wrap an async Express handler so rejected promises become JSON errors
 * instead of unhandled rejections that can take down the process.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => unknown
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((error: unknown) => {
        if (res.headersSent) {
          next(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        sendCaughtRouteError(res, error);
      });
  };
}
