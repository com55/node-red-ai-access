/**
 * HTTP handlers for node-types discovery and palette search (REST + GET-link).
 */

import type { Response } from 'express';

import { aiOpsErrorToHttp } from './ai-ops.js';
import { queryString } from './get-link/query.js';
import {
  type CatalogueFetcher,
  type NodeTypesAdapter,
  getNodeTypeDetail,
  listNodeTypes,
  searchPalette,
} from './node-types.js';
import type { AuthenticatedRequest } from './types.js';

const SAFE_ERROR_TEXT: Record<string, string> = {
  missing_node_type: 'Missing node type',
  missing_query: 'q query parameter is required',
  node_type_not_found: 'Node type was not found',
  catalogue_unavailable: 'Node-RED catalogue unavailable',
  unknown_node_type: 'Unknown node type',
  upstream_error: 'Upstream error',
};

function safeErrorText(code: string): string {
  return SAFE_ERROR_TEXT[code] ?? 'Request failed';
}

function sendJson(res: Response, statusCode: number, body: unknown): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(statusCode).json(body);
}

function sendMappedError(res: Response, error: unknown): boolean {
  const mapped = aiOpsErrorToHttp(error);
  if (!mapped) {
    return false;
  }
  const code = mapped.body.code;
  const body: Record<string, unknown> = {
    error: safeErrorText(code),
    code,
  };
  if (typeof mapped.body.type === 'string') {
    body.type = mapped.body.type;
  }
  if (Array.isArray(mapped.body.nearest)) {
    body.nearest = mapped.body.nearest;
  }
  if (typeof mapped.body.didYouMean === 'string') {
    body.didYouMean = mapped.body.didYouMean;
    body.caseSensitive = true;
    body.hint = `Types are case-sensitive — use '${mapped.body.didYouMean}' exactly.`;
  } else if (code === 'node_type_not_found' || code === 'unknown_node_type') {
    body.hint =
      'Call GET …/node-types?q= or …/palette/search?q=. Ask the user to install via Manage palette, then recheck node-types. This API never installs.';
  }
  if (code === 'catalogue_unavailable') {
    body.hint = 'Retry later; palette search is recommend-only and never installs packages.';
  }
  sendJson(res, mapped.statusCode, body);
  return true;
}

export interface NodeTypesRouteOptions {
  nodeTypes: NodeTypesAdapter;
  catalogueFetcher?: CatalogueFetcher;
  catalogueUrl?: string;
}

export function listNodeTypesHandler(options: NodeTypesRouteOptions) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const q = queryString(req.query, 'q');
      const result = await listNodeTypes(options.nodeTypes, q ? { q } : {});
      sendJson(res, 200, result);
    } catch (error) {
      if (sendMappedError(res, error)) {
        return;
      }
      sendJson(res, 502, {
        error: safeErrorText('upstream_error'),
        code: 'upstream_error',
      });
    }
  };
}

export function getNodeTypeHandler(options: NodeTypesRouteOptions) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const typeParam = req.params.type;
      const type = typeof typeParam === 'string' ? decodeURIComponent(typeParam) : '';
      const helpFlag = queryString(req.query, 'help');
      const includeHelp = !(
        helpFlag === '0' ||
        helpFlag === 'false' ||
        helpFlag === 'no' ||
        helpFlag === 'omit'
      );
      const detail = await getNodeTypeDetail(options.nodeTypes, type, { includeHelp });
      sendJson(res, 200, detail);
    } catch (error) {
      if (sendMappedError(res, error)) {
        return;
      }
      sendJson(res, 502, {
        error: safeErrorText('upstream_error'),
        code: 'upstream_error',
      });
    }
  };
}

export function searchPaletteHandler(options: NodeTypesRouteOptions) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const q = queryString(req.query, 'q');
      if (!q) {
        sendJson(res, 400, {
          error: safeErrorText('missing_query'),
          code: 'missing_query',
          hint: 'Pass ?q= to search the Node-RED catalogue (recommend only).',
        });
        return;
      }
      const result = await searchPalette(options.nodeTypes, q, {
        ...(options.catalogueFetcher ? { catalogueFetcher: options.catalogueFetcher } : {}),
        ...(options.catalogueUrl ? { catalogueUrl: options.catalogueUrl } : {}),
      });
      sendJson(res, 200, result);
    } catch (error) {
      if (sendMappedError(res, error)) {
        return;
      }
      sendJson(res, 502, {
        error: safeErrorText('upstream_error'),
        code: 'upstream_error',
      });
    }
  };
}
