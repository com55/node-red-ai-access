/**
 * List filters (invalid_filter on GET/REST/MCP), pagination fields,
 * duplicate_node_id, validation_failed, autoClosedCount, MCP argument mapping.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter } from '../../src/runtime/types.js';

const MCP_ACCEPT = 'application/json, text/event-stream';

interface Harness {
  app: Express;
  linkStore: AccessLinkStore;
  setRev: (rev: string) => void;
}

function createApp(userDir: string): Harness {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // Requests without a Bearer act as a signed-in admin (for admin list routes).
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (!req.headers.authorization) {
      (req as Request & { user?: unknown }).user = { username: 'admin', permissions: '*' };
    }
    next();
  });
  const linkStore = new AccessLinkStore({ maxActiveLinks: 20 });
  let rev = 'rev-1';
  const RED: NodeRedPluginAPI = {
    settings: {
      userDir,
      httpAdminRoot: '/',
      adminAuth: { type: 'credentials' },
      aiAccess: { defaultDeploymentType: 'nodes' },
    },
    httpAdmin: app,
    auth: {
      needsPermission() {
        return (_req: Request, _res: Response, next: NextFunction) => next();
      },
    },
    plugins: {
      registerPlugin() {
        // unused
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const nodes = (id: string) => [
    { id: 'n1', type: 'inject', name: 'tick', z: id, wires: [[]] },
    { id: 'n2', type: 'template', name: 'tpl', z: id, template: 'Hello', wires: [[]] },
  ];
  const adapter: FlowAdapter = {
    kind: 'red',
    getFlows: () =>
      Promise.resolve({
        rev,
        flows: [{ id: 'tab-1', type: 'tab', label: 'Main' }, ...nodes('tab-1')],
      }),
    getFlow: (id: string) =>
      Promise.resolve({
        rev,
        flow: { id, type: 'tab', label: 'Main', nodes: nodes(id), configs: [] },
      }),
    updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
  };
  registerRoutes(RED, { linkStore, flowAdapter: adapter });
  return {
    app,
    linkStore,
    setRev: next => {
      rev = next;
    },
  };
}

async function callTool(
  app: Express,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; json: Record<string, unknown>; raw: string }> {
  const res = await request(app)
    .post('/mcp/rpc')
    .set('Accept', MCP_ACCEPT)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const result = (res.body as { result?: { content?: { text: string }[]; isError?: boolean } })
    .result;
  const raw = String(result?.content?.[0]?.text ?? '');
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // leave empty — assertions below will fail with raw text visible
  }
  return { isError: result?.isError === true, json, raw };
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

async function submitRest(
  app: Express,
  token: string,
  title: string,
  name = title
): Promise<request.Response> {
  return request(app)
    .post('/mcp/api/v1/proposals')
    .set('Authorization', `Bearer ${token}`)
    .send({
      type: 'replace_flow',
      expectedRev: 'rev-1',
      title,
      payload: { flowId: 'tab-1', nodes: [{ op: 'set', id: 'n1', set: { name } }] },
    });
}

const BAD_FILTERS: [string, string, string][] = [
  ['status=bogus', 'status', 'pending'],
  ['limit=0', 'limit', '1–200'],
  ['limit=abc', 'limit', '1–200'],
  ['limit=201', 'limit', '1–200'],
  ['limit=1.5', 'limit', '1–200'],
  ['offset=-1', 'offset', '≥ 0'],
  ['mine=yes', 'mine', 'true'],
];

describe('list filters, pagination, validation errors', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-filters-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it.each(BAD_FILTERS)('REST %s → 400 invalid_filter', async (qs, parameter, allowed) => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest' });
    const res = await request(app)
      .get(`/mcp/api/v1/proposals?${qs}`)
      .set('Authorization', `Bearer ${link.token}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_filter');
    expect(res.body.parameter).toBe(parameter);
    expect(String(res.body.allowed)).toContain(allowed);
    expect(res.body.error).toContain(parameter);
  });

  it.each(BAD_FILTERS)('GET link %s → 400 invalid_filter', async (qs, parameter, allowed) => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link' });
    const res = await request(app).get(`/mcp/a/${link.token}/proposals?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_filter');
    expect(res.body.parameter).toBe(parameter);
    expect(String(res.body.allowed)).toContain(allowed);
  });

  it('admin REST list also rejects invalid filters', async () => {
    const { app } = createApp(userDir);
    const res = await request(app).get('/mcp/api/v1/proposals?limit=500');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_filter');
    expect(res.body.parameter).toBe('limit');
  });

  it.each([
    [{ status: 'bogus' }, 'status'],
    [{ limit: 0 }, 'limit'],
    [{ limit: 'abc' }, 'limit'],
    [{ limit: 201 }, 'limit'],
    [{ offset: -1 }, 'offset'],
    [{ mine: 'yes' }, 'mine'],
  ])('MCP list_proposals %j → invalid_filter (no raw Zod output)', async (args, parameter) => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'mcp' });
    const out = await callTool(app, link.token, 'list_proposals', args);
    expect(out.isError).toBe(true);
    expect(out.json.code).toBe('invalid_filter');
    expect(out.json.parameter).toBe(parameter);
    expect(out.json.statusCode).toBe(400);
    expect(typeof out.json.allowed).toBe('string');
    expect(out.raw).not.toMatch(/Input validation error|invalid_type|too_small|"path"/);
  });

  it('MCP argument errors on other tools → invalid_arguments naming the parameter', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'mcp' });
    const out = await callTool(app, link.token, 'get_proposal', { id: 42 });
    expect(out.isError).toBe(true);
    expect(out.json.code).toBe('invalid_arguments');
    expect(out.json.parameter).toBe('id');
    expect(out.json.statusCode).toBe(400);
    expect(out.raw).not.toMatch(/Input validation error/);
  });

  it('valid filters still work and pagination fields are consistent across channels', async () => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const getLink = linkStore.create({ kind: 'get_link' });
    const mcp = linkStore.create({ kind: 'mcp' });
    for (const t of ['p1', 'p2', 'p3']) {
      expect((await submitRest(app, rest.token, t)).status).toBe(201);
    }

    const r1 = await request(app)
      .get('/mcp/api/v1/proposals?limit=2&mine=false&status=pending')
      .set('Authorization', `Bearer ${rest.token}`);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ total: 3, offset: 0, limit: 2, hasMore: true, nextOffset: 2 });
    expect(r1.body.proposals).toHaveLength(2);

    const r2 = await request(app)
      .get('/mcp/api/v1/proposals?limit=2&offset=2')
      .set('Authorization', `Bearer ${rest.token}`);
    expect(r2.body).toMatchObject({ total: 3, offset: 2, limit: 2, hasMore: false });
    expect(r2.body).not.toHaveProperty('nextOffset');
    expect(r2.body.proposals).toHaveLength(1);

    const g = await request(app).get(`/mcp/a/${getLink.token}/proposals?limit=2`);
    expect(g.body).toMatchObject({ total: 3, offset: 0, limit: 2, hasMore: true, nextOffset: 2 });

    const m = await callTool(app, mcp.token, 'list_proposals', { limit: 2 });
    expect(m.isError).toBe(false);
    expect(m.json).toMatchObject({ total: 3, offset: 0, limit: 2, hasMore: true, nextOffset: 2 });

    const all = await request(app)
      .get('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${rest.token}`);
    expect(all.body).toMatchObject({ total: 3, offset: 0, hasMore: false });
    expect(all.body).not.toHaveProperty('limit');

    const admin = await request(app).get('/mcp/api/v1/proposals?limit=1');
    expect(admin.body).toMatchObject({
      total: 3,
      offset: 0,
      limit: 1,
      hasMore: true,
      nextOffset: 1,
    });
  });

  it('full-tab proposal with duplicate node ids → 400 duplicate_node_id', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest' });
    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: {
          flowId: 'tab-1',
          flow: {
            id: 'tab-1',
            type: 'tab',
            nodes: [
              { id: 'n1', type: 'inject', z: 'tab-1', wires: [[]] },
              { id: 'n1', type: 'debug', z: 'tab-1' },
            ],
            configs: [],
          },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('duplicate_node_id');
    expect(res.body.nodeId).toBe('n1');
  });

  it('duplicate ids across nodes and configs are rejected too', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'mcp' });
    const out = await callTool(app, link.token, 'submit_proposal', {
      type: 'replace_flow',
      expectedRev: 'rev-1',
      payload: {
        flowId: 'tab-1',
        flow: {
          id: 'tab-1',
          type: 'tab',
          nodes: [{ id: 'c1', type: 'inject', z: 'tab-1', wires: [[]] }],
          configs: [{ id: 'c1', type: 'mqtt-broker' }],
        },
      },
    });
    expect(out.isError).toBe(true);
    expect(out.json.code).toBe('duplicate_node_id');
  });

  it('batch with duplicate add ids → 400 duplicate_node_id (REST and GET)', async () => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const nodes = [
      { op: 'add', node: { id: 'x1', type: 'debug' } },
      { op: 'add', node: { id: 'x1', type: 'debug' } },
    ];
    const r = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${rest.token}`)
      .send({ type: 'replace_flow', expectedRev: 'rev-1', payload: { flowId: 'tab-1', nodes } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('duplicate_node_id');

    const getLink = linkStore.create({ kind: 'get_link' });
    const g = await request(app).get(
      `/mcp/a/${getLink.token}/propose?flow=tab-1&rev=rev-1&patch=${b64({ nodes })}`
    );
    expect(g.status).toBe(400);
    expect(g.body.code).toBe('duplicate_node_id');
  });

  it('batch with several errors → 400 validation_failed listing all errors', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest' });
    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: {
          flowId: 'tab-1',
          nodes: [
            { op: 'set', id: 'missing-a', set: { name: 'x' } },
            { op: 'set', id: 'missing-b', set: { name: 'y' } },
          ],
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.error).toBe('2 validation errors');
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors.map((e: { code: string }) => e.code)).toEqual([
      'node_not_found',
      'node_not_found',
    ]);
  });

  it('a single missing node stays 404 node_not_found', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest' });
    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', nodes: [{ op: 'set', id: 'missing', set: { name: 'x' } }] },
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('node_not_found');
    expect(res.body.errors).toHaveLength(1);
  });

  it('reports autoClosedCount instead of staleOnOlderRev', async () => {
    const { app, linkStore, setRev } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest' });
    const first = await submitRest(app, link.token, 'old');
    expect(first.status).toBe(201);
    expect(first.body).not.toHaveProperty('staleOnOlderRev');
    expect(first.body).not.toHaveProperty('autoClosedCount');

    // Live rev moves: the next list auto-closes the old pending proposal.
    setRev('rev-9');
    const listed = await request(app)
      .get('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.autoClosedCount).toBe(1);
    expect(listed.body.proposals[0].status).toBe('expired');
    expect(listed.body).not.toHaveProperty('staleOnOlderRev');

    const again = await request(app)
      .get('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`);
    expect(again.body).not.toHaveProperty('autoClosedCount');
  });
});
