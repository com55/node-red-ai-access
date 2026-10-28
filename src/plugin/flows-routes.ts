/**
 * Read-only flow routes for admins and access-link clients.
 */

import type { Response } from 'express';

import type { FlowAdapter } from '../runtime/types.js';

import { aiOpsErrorToHttp, getFlow, listFlows } from './ai-ops.js';
import { CANONICAL_ERROR_TEXT } from './channel-errors.js';
import { adapterForRequest } from './secret-redaction.js';
import type { AuthenticatedRequest } from './types.js';

/** Fixed JSON error text — never echo exception / path segments (CodeQL XSS). */
function safeErrorText(code: string): string {
  return CANONICAL_ERROR_TEXT[code] ?? 'Request failed';
}

function sendMappedFlowError(res: Response, error: unknown): boolean {
  const mapped = aiOpsErrorToHttp(error, 'rest');
  if (!mapped) {
    return false;
  }
  const code = mapped.body.code;
  const body: Record<string, unknown> = {
    error: safeErrorText(code),
    code,
  };
  if (typeof mapped.body.hint === 'string') {
    body.hint = mapped.body.hint;
  }
  if (typeof mapped.body.expectedRev === 'string') {
    body.expectedRev = mapped.body.expectedRev;
  }
  if (typeof mapped.body.currentRev === 'string') {
    body.currentRev = mapped.body.currentRev;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(mapped.statusCode).json(body);
  return true;
}

export function listFlowsHandler(adapter: FlowAdapter) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      res.json(await listFlows(adapterForRequest(req, adapter)));
    } catch (error) {
      if (sendMappedFlowError(res, error)) {
        return;
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(502).json({ error: safeErrorText('upstream_error'), code: 'upstream_error' });
    }
  };
}

export function getFlowHandler(adapter: FlowAdapter) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const flowId = req.params.id;
    if (typeof flowId !== 'string' || flowId.length === 0) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(400).json({ error: safeErrorText('missing_flow_id'), code: 'missing_flow_id' });
      return;
    }
    try {
      res.json(await getFlow(adapterForRequest(req, adapter), flowId));
    } catch (error) {
      if (sendMappedFlowError(res, error)) {
        return;
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(502).json({ error: safeErrorText('upstream_error'), code: 'upstream_error' });
    }
  };
}
