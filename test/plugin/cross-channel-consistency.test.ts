/**
 * Cross-channel consistency: slim MCP proposals, shared error hints,
 * 415 non-JSON, WWW-Authenticate on wrong_token_kind, empty search → missing_query.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import {
  ACCESS_LINK_MISSING_CODE,
  ACCESS_LINK_WWW_AUTHENTICATE,
  WRONG_TOKEN_KIND_CODE,
} from '../../src/plugin/access-link-auth.js';
import { channelErrorHint } from '../../src/plugin/channel-errors.js';
import { registerRoutes } from '../../src/plugin/index.js';
import { createStaticNodeTypesAdapter } from '../../src/plugin/node-types.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter, FlowTab } from '../../src/runtime/types.js';

const MCP_ACCEPT = 'application/json, text/event-stream';

function createApp(userDir: string): { app: Express; linkStore: AccessLinkStore } {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 20, defaultTtlSeconds: 14_400 });
  const flow: FlowTab = {
    id: 'tab-1',
    type: 'tab',
    label: 'Main',
    nodes: [{ id: 'n1', type: 'inject', z: 'tab-1', name: 'In', wires: [[]] }],
  };
  const adapter = {
    kind: 'red',
    getFlows: () => Promise.resolve({ rev: 'rev-1', flows: [{ id: 'tab-1', type: 'tab' }] }),
    getFlow: (id: string) =>
      Promise.resolve({
        rev: 'rev-1',
        flow: { ...flow, id, nodes: flow.nodes?.map(n => ({ ...n })) },
      }),
    updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
  } as FlowAdapter;

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir,
      httpAdminRoot: '/',
      adminAuth: { type: 'credentials' },
      aiAccess: { defaultDeploymentType: 'nodes', defaultLinkTtlSeconds: 14_400 },
    },
    httpAdmin: app,
    auth: {
      needsPermission() {
        return (_req: Request, _res: Response, next: NextFunction) => next();
      },
    },
    plugins: {
      registerPlugin() {
        return undefined;
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  registerRoutes(RED, {
    linkStore,
    flowAdapter: adapter,
    nodeTypesAdapter: createStaticNodeTypesAdapter(['inject', 'debug']),
  });
  return { app, linkStore };
}

async function callTool(
  app: Express,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
) {
  const res = await request(app)
    .post('/mcp/rpc')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', MCP_ACCEPT)
    .set('Content-Type', 'application/json')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
  return res;
}

function parseToolJson(result: unknown): unknown {
  const r = result as { content?: { type: string; text: string }[]; isError?: boolean };
  const text = r.content?.[0]?.text ?? '';
  return JSON.parse(text) as unknown;
}

describe('cross-channel consistency', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-xchan-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('channel hints: MCP has no URL paths; REST has no ./flows', () => {
    const mcp = channelErrorHint('node_not_found', 'mcp') ?? '';
    const rest = channelErrorHint('node_not_found', 'rest') ?? '';
    const get = channelErrorHint('node_not_found', 'get') ?? '';
    expect(mcp).toMatch(/get_flow|get_node/);
    expect(mcp).not.toMatch(/GET\s|\/flows|\.\//);
    expect(rest).toMatch(/GET \/flows/);
    expect(rest).not.toMatch(/\.\//);
    expect(get).toMatch(/GET/);
  });

  it('POST /proposals without token returns access_link_missing', async () => {
    const { app } = createApp(userDir);
    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Content-Type', 'application/json')
      .send({ type: 'replace_flow', expectedRev: 'rev-1', payload: { flowId: 'tab-1' } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ACCESS_LINK_MISSING_CODE);
    expect(res.headers['www-authenticate']).toBe(ACCESS_LINK_WWW_AUTHENTICATE);
    expect(res.headers['www-authenticate']).not.toMatch(/Users/);
  });

  it('POST /proposals with non-JSON Content-Type returns 415', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest', label: 'bot' });
    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .set('Content-Type', 'text/plain')
      .send('not-json');
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('unsupported_media_type');
    expect(res.body.hint).toMatch(/application\/json/i);
  });

  it('wrong_token_kind includes WWW-Authenticate', async () => {
    const { app, linkStore } = createApp(userDir);
    const mcp = linkStore.create({ kind: 'mcp', label: 'mcp-tok' });
    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${mcp.token}`)
      .set('Content-Type', 'application/json')
      .send({ type: 'replace_flow', expectedRev: 'rev-1', payload: { flowId: 'tab-1' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(WRONG_TOKEN_KIND_CODE);
    expect(res.headers['www-authenticate']).toBe(ACCESS_LINK_WWW_AUTHENTICATE);
  });

  it('MCP empty search_palette returns missing_query (not Zod -32602)', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'mcp', label: 'bot' });
    const res = await callTool(app, link.token, 'search_palette', { q: '' });
    expect(res.status).toBe(200);
    expect(res.body.result?.isError).toBe(true);
    const body = parseToolJson(res.body.result) as { code: string; hint?: string };
    expect(body.code).toBe('missing_query');
    expect(String(body.hint ?? '')).not.toMatch(/GET |\/palette/);
  });

  it('MCP empty search_flows returns missing_query', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'mcp', label: 'bot' });
    const res = await callTool(app, link.token, 'search_flows', { q: '   ' });
    expect(res.status).toBe(200);
    expect(res.body.result?.isError).toBe(true);
    const body = parseToolJson(res.body.result) as { code: string };
    expect(body.code).toBe('missing_query');
  });
});
