/**
 * HTTP handlers for layered reads (REST + shared with GET-link wrappers).
 */

import type { Response } from 'express';

import type { FlowAdapter } from '../runtime/types.js';

import { aiOpsErrorToHttp, getFlow } from './ai-ops.js';
import { queryString } from './get-link/query.js';
import {
  getFlowSummary,
  getNodeById,
  getNodeField,
  isTruthyQueryFlag,
  searchFlows,
} from './layered-read.js';
import type { AuthenticatedRequest } from './types.js';

function sendMappedError(res: Response, error: unknown, notFoundHint?: string): boolean {
  const mapped = aiOpsErrorToHttp(error);
  if (!mapped) {
    return false;
  }
  const hint =
    notFoundHint &&
    (mapped.body.code === 'node_not_found' ||
      mapped.body.code === 'flow_not_found' ||
      mapped.body.code === 'field_not_found')
      ? notFoundHint
      : undefined;
  res.status(mapped.statusCode).json({
    ...mapped.body,
    ...(hint ? { hint } : {}),
  });
  return true;
}

/** Extend get-flow with `?summary=1`. */
export function getFlowOrSummaryHandler(adapter: FlowAdapter) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const flowId = req.params.id;
    if (typeof flowId !== 'string' || flowId.length === 0) {
      res.status(400).json({ error: 'Missing flow id', code: 'missing_flow_id' });
      return;
    }
    const summary = isTruthyQueryFlag(queryString(req.query, 'summary'));
    try {
      if (summary) {
        res.json(await getFlowSummary(adapter, flowId));
        return;
      }
      res.json(await getFlow(adapter, flowId));
    } catch (error) {
      if (
        sendMappedError(res, error, 'Use an id from GET /flows (or GET ./flows on an access link).')
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: message, code: 'upstream_error' });
    }
  };
}

export function getNodeHandler(adapter: FlowAdapter) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const nodeId = req.params.id;
    if (typeof nodeId !== 'string' || !nodeId) {
      res.status(400).json({ error: 'Missing node id', code: 'missing_node_id' });
      return;
    }
    const flowId = queryString(req.query, 'flow');
    try {
      res.json(await getNodeById(adapter, nodeId, flowId));
    } catch (error) {
      if (sendMappedError(res, error, 'Call GET …/flows/<id>?summary=1 or …/search?q=…')) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: message, code: 'upstream_error' });
    }
  };
}

export function getNodeFieldHandler(adapter: FlowAdapter) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const nodeId = req.params.id;
    const field = req.params.name;
    if (typeof nodeId !== 'string' || !nodeId) {
      res.status(400).json({ error: 'Missing node id', code: 'missing_node_id' });
      return;
    }
    if (typeof field !== 'string' || !field) {
      res.status(400).json({ error: 'Missing field name', code: 'missing_field' });
      return;
    }
    const flowId = queryString(req.query, 'flow');
    const lines = queryString(req.query, 'lines');
    try {
      res.json(
        await getNodeField(adapter, nodeId, field, {
          ...(flowId ? { flowId } : {}),
          ...(lines ? { lines } : {}),
        })
      );
    } catch (error) {
      if (sendMappedError(res, error, 'Use summary/search to discover node ids and fields.')) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: message, code: 'upstream_error' });
    }
  };
}

export function searchFlowsHandler(adapter: FlowAdapter) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const q = queryString(req.query, 'q');
    if (!q) {
      res.status(400).json({
        error: 'q query parameter is required',
        code: 'missing_query',
        hint: 'Example: GET …/search?q=TODO&flow=tab1',
      });
      return;
    }
    const flowId = queryString(req.query, 'flow');
    try {
      res.json(await searchFlows(adapter, q, flowId ? { flowId } : {}));
    } catch (error) {
      if (sendMappedError(res, error)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: message, code: 'upstream_error' });
    }
  };
}
