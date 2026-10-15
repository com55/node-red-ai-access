/**
 * Read-only flow routes for admins and access-link clients.
 */

import type { Response } from 'express';

import { FlowNotFoundError } from '../runtime/errors.js';
import type { FlowAdapter } from '../runtime/types.js';

import type { AuthenticatedRequest } from './types.js';

export function listFlowsHandler(adapter: FlowAdapter) {
  return async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const snapshot = await adapter.getFlows();
      res.json({ rev: snapshot.rev, flows: snapshot.flows });
    } catch (error) {
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
      const snapshot = await adapter.getFlow(flowId);
      res.json({ rev: snapshot.rev, flow: snapshot.flow });
    } catch (error) {
      if (error instanceof FlowNotFoundError) {
        res.status(404).json({ error: error.message, code: error.code });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: message });
    }
  };
}
