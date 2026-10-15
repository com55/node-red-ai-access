/**
 * Read-only flow routes for admins and access-link clients.
 */

import type { Response } from 'express';

import type { FlowAdapter } from '../runtime/types.js';

import { aiOpsErrorToHttp, getFlow, listFlows } from './ai-ops.js';
import type { AuthenticatedRequest } from './types.js';

export function listFlowsHandler(adapter: FlowAdapter) {
  return async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      res.json(await listFlows(adapter));
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error);
      if (mapped) {
        res.status(mapped.statusCode).json(mapped.body);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: message });
    }
  };
}

export function getFlowHandler(adapter: FlowAdapter) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const flowId = req.params.id;
    if (typeof flowId !== 'string' || flowId.length === 0) {
      res.status(400).json({ error: 'Missing flow id' });
      return;
    }
    try {
      res.json(await getFlow(adapter, flowId));
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error);
      if (mapped) {
        res.status(mapped.statusCode).json(mapped.body);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: message });
    }
  };
}
