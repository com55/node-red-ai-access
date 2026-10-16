/**
 * Unauthenticated JSON discovery index at `GET /mcp/api/v1`.
 */

import type { Response } from 'express';

import { mcpApiBase, mcpRpcPath } from './auth.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

/** Injected by tsup / vitest define. */
declare const __AI_ACCESS_VERSION__: string | undefined;

export interface DiscoveryEndpoint {
  method: string;
  path: string;
  auth: 'none' | 'admin' | 'access-link' | 'admin-or-access-link';
  summary: string;
}

export function buildDiscoveryIndex(RED: NodeRedPluginAPI): Record<string, unknown> {
  const api = mcpApiBase(RED.settings.httpAdminRoot);
  const rpc = mcpRpcPath(RED.settings.httpAdminRoot);
  const version =
    typeof __AI_ACCESS_VERSION__ === 'string' && __AI_ACCESS_VERSION__.length > 0
      ? __AI_ACCESS_VERSION__
      : '0.0.0';

  const endpoints: DiscoveryEndpoint[] = [
    {
      method: 'GET',
      path: '/',
      auth: 'none',
      summary: 'This discovery index',
    },
    {
      method: 'GET',
      path: '/openapi.yaml',
      auth: 'none',
      summary: 'OpenAPI 3.1 specification (YAML)',
    },
    {
      method: 'GET',
      path: '/openapi.json',
      auth: 'none',
      summary: 'OpenAPI 3.1 specification (JSON)',
    },
    {
      method: 'GET',
      path: '/status',
      auth: 'admin-or-access-link',
      summary: 'Plugin status and caller info',
    },
    {
      method: 'GET',
      path: '/flows',
      auth: 'admin-or-access-link',
      summary: 'List flows + rev',
    },
    {
      method: 'GET',
      path: '/flows/{id}',
      auth: 'admin-or-access-link',
      summary: 'Get one flow tab + rev (?summary=1 for node list without field contents)',
    },
    {
      method: 'GET',
      path: '/nodes/{id}',
      auth: 'admin-or-access-link',
      summary: 'Get one full node (optional ?flow=)',
    },
    {
      method: 'GET',
      path: '/nodes/{id}/field/{name}',
      auth: 'admin-or-access-link',
      summary: 'Get one node field (?lines=A-B optional)',
    },
    {
      method: 'GET',
      path: '/search',
      auth: 'admin-or-access-link',
      summary: 'Text search across string fields (?q=&flow=)',
    },
    {
      method: 'GET',
      path: '/node-types',
      auth: 'admin-or-access-link',
      summary: 'List installed palette node types (?q= filter)',
    },
    {
      method: 'GET',
      path: '/node-types/{type}',
      auth: 'admin-or-access-link',
      summary:
        'Detail for one installed node type (defaults JSON, inputs/outputs, help; ?help=0 omits help)',
    },
    {
      method: 'GET',
      path: '/palette/search',
      auth: 'admin-or-access-link',
      summary: 'Search Node-RED catalogue (recommend only; never installs) (?q=)',
    },
    {
      method: 'POST',
      path: '/proposals',
      auth: 'access-link',
      summary: 'Create a replace_flow proposal',
    },
    {
      method: 'GET',
      path: '/proposals',
      auth: 'admin-or-access-link',
      summary: 'List proposals (admin: all; link: own)',
    },
    {
      method: 'GET',
      path: '/proposals/{id}',
      auth: 'admin-or-access-link',
      summary: 'Get one proposal',
    },
    {
      method: 'GET',
      path: '/proposals/{id}/diff',
      auth: 'admin-or-access-link',
      summary: 'Diff proposal vs current flow',
    },
  ];

  return {
    ok: true,
    name: 'node-red-ai-access',
    version,
    description:
      'Temporary, owner-approved Node-RED access for AI clients over plain HTTP (REST) or MCP.',
    auth: {
      scheme: 'Bearer',
      header: 'Authorization: Bearer <token>',
      description:
        'An admin with * mints tokens on the /mcp Access links page (POST /links only — never under GET /mcp/a/<token>). Each token has kind get_link | rest | mcp and only works on that surface. Send rest/mcp tokens as Authorization: Bearer <token>. Missing/invalid → 401 access_link_missing / access_link_invalid; wrong kind → 403 wrong_token_kind. GET /mcp/a links cannot create tokens.',
      tokenKinds: ['get_link', 'rest', 'mcp'],
      mint: {
        path: '/links',
        method: 'POST',
        auth: 'admin',
        note: 'Admin * only. Not available under /mcp/a/<token>.',
      },
    },
    openapi: `${api}/openapi.yaml`,
    openapiJson: `${api}/openapi.json`,
    mcp: rpc,
    apiBase: api,
    getLink: {
      base: '/mcp/a/<token>',
      canMintTokens: false,
      note: 'Self-contained GET surface for get_link tokens only. No POST /links equivalent.',
    },
    endpoints,
  };
}

/** Public GET handler — no auth required. */
export function discoveryIndexHandler(RED: NodeRedPluginAPI) {
  return (_req: AuthenticatedRequest, res: Response): void => {
    res.status(200).json(buildDiscoveryIndex(RED));
  };
}

/** JSON 404 for unmatched routes under `/mcp/api/v1`. */
export function mcpApiNotFoundHandler() {
  return (_req: AuthenticatedRequest, res: Response): void => {
    res.status(404).json({ error: 'Not found', code: 'not_found' });
  };
}
