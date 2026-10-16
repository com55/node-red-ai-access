/**
 * HTTP handlers for layered reads (REST + shared with GET-link wrappers).
 *
 * All responses are JSON with X-Content-Type-Options: nosniff. Error text is
 * always a fixed string from SAFE_ERROR_TEXT — never path/query/exception text —
 * so browsers cannot reinterpret these bodies as HTML (CodeQL XSS / exception-as-HTML).
 */

import type { Response } from 'express';

import type { FlowAdapter } from '../runtime/types.js';

import { aiOpsErrorToHttp, getFlow } from './ai-ops.js';
import { CANONICAL_ERROR_TEXT, channelErrorHint, type ErrorChannel } from './channel-errors.js';
import { queryString } from './get-link/query.js';
import {
  getFlowSummary,
  getNodeById,
  getNodeField,
  isTruthyQueryFlag,
  searchFlows,
} from './layered-read.js';
import type { AuthenticatedRequest } from './types.js';

function layeredReadErrorHint(
  code: string,
  channel: ErrorChannel,
  notFoundHint?: string
): string | undefined {
  switch (code) {
    case 'node_not_found':
    case 'flow_not_found':
    case 'field_not_found':
      return notFoundHint ?? channelErrorHint(code, channel);
    default:
      return channelErrorHint(code, channel);
  }
}

function safeErrorText(code: string): string {
  return CANONICAL_ERROR_TEXT[code] ?? 'Request failed';
}

/** JSON response with nosniff — never treat as HTML. */
function sendJson(res: Response, statusCode: number, body: unknown): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(statusCode).json(body);
}

function sendMappedError(
  res: Response,
  error: unknown,
  channel: ErrorChannel,
  notFoundHint?: string
): boolean {
  const mapped = aiOpsErrorToHttp(error, channel);
  if (!mapped) {
    return false;
  }
  const code = mapped.body.code;
  const body: Record<string, unknown> = {
    error: safeErrorText(code),
    code,
  };
  // Preserve structured numeric/boolean details only (not message text).
  if (typeof mapped.body.matchCount === 'number') {
    body.matchCount = mapped.body.matchCount;
  }
  if (typeof mapped.body.totalLines === 'number') {
    body.totalLines = mapped.body.totalLines;
  }
  if (typeof mapped.body.expectedRev === 'string') {
    body.expectedRev = mapped.body.expectedRev;
  }
  if (typeof mapped.body.currentRev === 'string') {
    body.currentRev = mapped.body.currentRev;
  }
  const hint = layeredReadErrorHint(code, channel, notFoundHint);
  if (hint) {
    body.hint = hint;
  }
  sendJson(res, mapped.statusCode, body);
  return true;
}

function sendUpstreamError(res: Response): void {
  sendJson(res, 502, {
    error: safeErrorText('upstream_error'),
    code: 'upstream_error',
  });
}

/** Extend get-flow with `?summary=1`. */
export function getFlowOrSummaryHandler(adapter: FlowAdapter, channel: ErrorChannel = 'rest') {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const flowId = req.params.id;
    if (typeof flowId !== 'string' || flowId.length === 0) {
      sendJson(res, 400, {
        error: safeErrorText('missing_flow_id'),
        code: 'missing_flow_id',
      });
      return;
    }
    const summary = isTruthyQueryFlag(queryString(req.query, 'summary'));
    try {
      if (summary) {
        sendJson(res, 200, await getFlowSummary(adapter, flowId));
        return;
      }
      sendJson(res, 200, await getFlow(adapter, flowId));
    } catch (error) {
      // Channel-aware flow_not_found hint (GET → ./flows; REST → GET /flows).
      if (sendMappedError(res, error, channel)) {
        return;
      }
      sendUpstreamError(res);
    }
  };
}

export function getNodeHandler(adapter: FlowAdapter, channel: ErrorChannel = 'rest') {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const nodeId = req.params.id;
    if (typeof nodeId !== 'string' || !nodeId) {
      sendJson(res, 400, {
        error: safeErrorText('missing_node_id'),
        code: 'missing_node_id',
      });
      return;
    }
    const flowId = queryString(req.query, 'flow');
    try {
      sendJson(res, 200, await getNodeById(adapter, nodeId, flowId));
    } catch (error) {
      const notFoundHint =
        channel === 'get'
          ? 'Call GET …/flows/<id>?summary=1 or …/search?q=…'
          : channel === 'mcp'
            ? undefined
            : 'Call GET …/flows/<id>?summary=1 or …/search?q=…';
      if (sendMappedError(res, error, channel, notFoundHint)) {
        return;
      }
      sendUpstreamError(res);
    }
  };
}

export function getNodeFieldHandler(adapter: FlowAdapter, channel: ErrorChannel = 'rest') {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const nodeId = req.params.id;
    const field = req.params.name;
    if (typeof nodeId !== 'string' || !nodeId) {
      sendJson(res, 400, {
        error: safeErrorText('missing_node_id'),
        code: 'missing_node_id',
      });
      return;
    }
    if (typeof field !== 'string' || !field) {
      sendJson(res, 400, {
        error: safeErrorText('missing_field'),
        code: 'missing_field',
      });
      return;
    }
    const flowId = queryString(req.query, 'flow');
    const lines = queryString(req.query, 'lines');
    try {
      sendJson(
        res,
        200,
        await getNodeField(adapter, nodeId, field, {
          ...(flowId ? { flowId } : {}),
          ...(lines ? { lines } : {}),
        })
      );
    } catch (error) {
      if (
        sendMappedError(res, error, channel, 'Use summary/search to discover node ids and fields.')
      ) {
        return;
      }
      sendUpstreamError(res);
    }
  };
}

export function searchFlowsHandler(adapter: FlowAdapter, channel: ErrorChannel = 'rest') {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const q = queryString(req.query, 'q');
    if (!q) {
      sendJson(res, 400, {
        error: safeErrorText('missing_query'),
        code: 'missing_query',
        hint:
          channel === 'get'
            ? 'Example: GET …/search?q=TODO&flow=tab1'
            : channelErrorHint('missing_query', channel),
      });
      return;
    }
    const flowId = queryString(req.query, 'flow');
    try {
      sendJson(res, 200, await searchFlows(adapter, q, flowId ? { flowId } : {}));
    } catch (error) {
      if (sendMappedError(res, error, channel)) {
        return;
      }
      sendUpstreamError(res);
    }
  };
}
