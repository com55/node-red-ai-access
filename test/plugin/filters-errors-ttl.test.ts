/**
 * List filters (invalid_filter on GET/REST/MCP), pagination fields,
 * duplicate_node_id, validation_failed, autoClosedCount, MCP argument mapping.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import { installMcpArgumentErrorMapping } from '../../src/plugin/mcp-rpc.js';
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
        flows: [
          { id: 'tab-1', type: 'tab', label: 'Main' },
          ...nodes('tab-1'),
          { id: 'tab-2', type: 'tab', label: 'Other' },
          { id: 'o1', type: 'inject', z: 'tab-2', wires: [[]] },
          { id: 'sf1', type: 'subflow', name: 'Sub' },
          { id: 'g1', type: 'mqtt-broker' },
        ],
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
      .get('/mcp/api/v1/proposals?limit=2&mine=true&status=pending')
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

describe('PR #74 follow-ups: whole-file ids, multi-status, messages, hints, mine=false', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-followups-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  function fullTab(extraId: string) {
    return {
      type: 'replace_flow',
      expectedRev: 'rev-1',
      payload: {
        flowId: 'tab-1',
        flow: {
          id: 'tab-1',
          type: 'tab',
          nodes: [
            { id: 'n1', type: 'inject', z: 'tab-1', wires: [[]] },
            { id: extraId, type: 'inject', z: 'tab-1', wires: [[]] },
          ],
          configs: [],
        },
      },
    };
  }

  it.each([
    ['tab-1', /equals the tab id/],
    ['tab-2', /tab 'Other'/],
    ['o1', /inject node on 'tab-2'/],
    ['sf1', /subflow 'sf1'|subflow/],
    ['g1', /global mqtt-broker config node/],
  ])('REST full tab reusing %s anywhere in the flows file → duplicate_node_id', async (id, re) => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest' });
    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send(fullTab(id));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('duplicate_node_id');
    expect(res.body.nodeId).toBe(id);
    expect(res.body.error).toMatch(re);
  });

  it('MCP full tab with a node id equal to the tab id → duplicate_node_id', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'mcp' });
    const out = await callTool(app, link.token, 'submit_proposal', fullTab('tab-1'));
    expect(out.isError).toBe(true);
    expect(out.json.code).toBe('duplicate_node_id');
  });

  it('batch add reusing a node id from another tab → duplicate_node_id', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest' });
    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', nodes: [{ op: 'add', node: { id: 'o1', type: 'debug' } }] },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('duplicate_node_id');
  });

  async function seedStatuses(h: Harness, token: string): Promise<void> {
    // two pending, then move rev so a list closes them as expired, then one new pending
    expect((await submitRest(h.app, token, 'a')).status).toBe(201);
    h.setRev('rev-2');
    await request(h.app).get('/mcp/api/v1/proposals').set('Authorization', `Bearer ${token}`);
    h.setRev('rev-1');
  }

  it('status supports comma-separated and repeated values on REST and GET', async () => {
    const h = createApp(userDir);
    const rest = h.linkStore.create({ kind: 'rest' });
    const getLink = h.linkStore.create({ kind: 'get_link' });
    await seedStatuses(h, rest.token);
    expect((await submitRest(h.app, rest.token, 'b')).status).toBe(201);
    // rev-1 again: the list below would expire nothing new (b is on rev-1).
    for (const qs of [
      'status=pending,expired',
      'status=pending&status=expired',
      'status=pending,%20expired',
    ]) {
      const r = await request(h.app)
        .get(`/mcp/api/v1/proposals?${qs}`)
        .set('Authorization', `Bearer ${rest.token}`);
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(2);
      const g = await request(h.app).get(`/mcp/a/${getLink.token}/proposals?${qs}`);
      expect(g.status).toBe(200);
      expect(g.body.total).toBe(2);
    }
    const onlyExpired = await request(h.app)
      .get('/mcp/api/v1/proposals?status=expired')
      .set('Authorization', `Bearer ${rest.token}`);
    expect(onlyExpired.body.total).toBe(1);
  });

  it('status multi-value on MCP: array and comma string', async () => {
    const h = createApp(userDir);
    const rest = h.linkStore.create({ kind: 'rest' });
    const mcp = h.linkStore.create({ kind: 'mcp' });
    await seedStatuses(h, rest.token);
    expect((await submitRest(h.app, rest.token, 'b')).status).toBe(201);
    const arr = await callTool(h.app, mcp.token, 'list_proposals', {
      status: ['pending', 'expired'],
    });
    expect(arr.isError).toBe(false);
    expect(arr.json.total).toBe(2);
    const comma = await callTool(h.app, mcp.token, 'list_proposals', { status: 'pending,expired' });
    expect(comma.json.total).toBe(2);
  });

  it('any invalid status in the set → invalid_filter on every channel', async () => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const getLink = linkStore.create({ kind: 'get_link' });
    const mcp = linkStore.create({ kind: 'mcp' });
    for (const qs of ['status=pending,bogus', 'status=pending&status=bogus']) {
      const r = await request(app)
        .get(`/mcp/api/v1/proposals?${qs}`)
        .set('Authorization', `Bearer ${rest.token}`);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code: 'invalid_filter', parameter: 'status' });
      const g = await request(app).get(`/mcp/a/${getLink.token}/proposals?${qs}`);
      expect(g.status).toBe(400);
      expect(g.body.code).toBe('invalid_filter');
    }
    for (const status of [['pending', 'bogus'], 'pending,bogus', [42]]) {
      const m = await callTool(app, mcp.token, 'list_proposals', { status });
      expect(m.isError).toBe(true);
      expect(m.json).toMatchObject({ code: 'invalid_filter', parameter: 'status' });
    }
  });

  it('repeated single-value params (limit) → invalid_filter on REST and GET', async () => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const getLink = linkStore.create({ kind: 'get_link' });
    const r = await request(app)
      .get('/mcp/api/v1/proposals?limit=1&limit=2')
      .set('Authorization', `Bearer ${rest.token}`);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'invalid_filter', parameter: 'limit' });
    expect(r.body.error).toMatch(/at most once/);
    const g = await request(app).get(`/mcp/a/${getLink.token}/proposals?mine=1&mine=0`);
    expect(g.body).toMatchObject({ code: 'invalid_filter', parameter: 'mine' });
  });

  it('single validation error keeps its specific message (not the generic text)', async () => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const mcp = linkStore.create({ kind: 'mcp' });
    const body = {
      type: 'replace_flow',
      expectedRev: 'rev-1',
      payload: { flowId: 'tab-1', nodes: [{ op: 'set', id: 'ghost', set: { name: 'x' } }] },
    };
    const r = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${rest.token}`)
      .send(body);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('node_not_found');
    expect(r.body.error).toMatch(/ghost/);
    const m = await callTool(app, mcp.token, 'submit_proposal', body);
    expect(m.json.code).toBe('node_not_found');
    expect(String(m.json.error)).toMatch(/ghost/);
  });

  it('hints are consistent: node_already_exists and validation_failed carry hints; errors[] has no statusCode', async () => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const mcp = linkStore.create({ kind: 'mcp' });
    const getLink = linkStore.create({ kind: 'get_link' });
    const exists = {
      type: 'replace_flow',
      expectedRev: 'rev-1',
      payload: { flowId: 'tab-1', nodes: [{ op: 'add', node: { id: 'n1', type: 'debug' } }] },
    };
    const r = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${rest.token}`)
      .send(exists);
    expect(r.body.code).toBe('node_already_exists');
    expect(typeof r.body.hint).toBe('string');
    const m = await callTool(app, mcp.token, 'submit_proposal', exists);
    expect(m.json.code).toBe('node_already_exists');
    expect(m.json.hint).toBe(r.body.hint);

    const multi = {
      type: 'replace_flow',
      expectedRev: 'rev-1',
      payload: {
        flowId: 'tab-1',
        nodes: [
          { op: 'set', id: 'ghost-a', set: { name: 'x' } },
          { op: 'set', id: 'ghost-b', set: { name: 'y' } },
        ],
      },
    };
    const vr = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${rest.token}`)
      .send(multi);
    expect(vr.body.code).toBe('validation_failed');
    expect(vr.body.hint).toMatch(/errors\[\]/);
    for (const e of vr.body.errors as Record<string, unknown>[]) {
      expect(e).not.toHaveProperty('statusCode');
    }
    const vm = await callTool(app, mcp.token, 'submit_proposal', multi);
    expect(vm.json.hint).toBe(vr.body.hint);
    const vg = await request(app).get(
      `/mcp/a/${getLink.token}/propose?flow=tab-1&rev=rev-1&patch=${b64({ nodes: multi.payload.nodes })}`
    );
    expect(vg.body.code).toBe('validation_failed');
    expect(vg.body.hint).toBe(vr.body.hint);
  });

  it('mine=false lists only proposals from other links (REST, GET, MCP)', async () => {
    const { app, linkStore } = createApp(userDir);
    const a = linkStore.create({ kind: 'rest', label: 'a' });
    const b = linkStore.create({ kind: 'rest', label: 'b' });
    expect((await submitRest(app, a.token, 'from-a')).status).toBe(201);
    expect((await submitRest(app, b.token, 'from-b', 'other')).status).toBe(201);
    const r = await request(app)
      .get('/mcp/api/v1/proposals?mine=false')
      .set('Authorization', `Bearer ${a.token}`);
    expect(r.body.total).toBe(1);
    expect(r.body.proposals[0]).toMatchObject({ mine: false });
    const r0 = await request(app)
      .get('/mcp/api/v1/proposals?mine=0')
      .set('Authorization', `Bearer ${a.token}`);
    expect(r0.body.total).toBe(1);

    const getLink = linkStore.create({ kind: 'get_link' });
    const g = await request(app).get(`/mcp/a/${getLink.token}/proposals?mine=false`);
    expect(g.body.total).toBe(2);
    const mcp = linkStore.create({ kind: 'mcp' });
    const m = await callTool(app, mcp.token, 'list_proposals', { mine: false });
    expect(m.json.total).toBe(2);
    const mt = await callTool(app, mcp.token, 'list_proposals', { mine: true });
    expect(mt.json.total).toBe(0);
  });

  it('GET guide covers invalid_ttl, unsupported_media_type, superseded, autoClosedCount', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link' });
    const docs = await request(app).get(`/mcp/a/${link.token}`);
    expect(docs.status).toBe(200);
    for (const term of ['invalid_ttl', 'unsupported_media_type', 'superseded', 'autoClosedCount']) {
      expect(docs.text).toContain(term);
    }
  });

  it('package ships docs/errors.md, mcp-tools.md, mcp-clients.md; no maps; openapi once', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      files: string[];
      engines: { node: string };
      keywords: string[];
      scripts: Record<string, string>;
    };
    for (const f of ['docs/errors.md', 'docs/mcp-tools.md', 'docs/mcp-clients.md']) {
      expect(pkg.files).toContain(f);
    }
    expect(pkg.files).toContain('!dist/**/*.map');
    expect(pkg.files).not.toContain('docs/api/openapi.yaml');
    expect(pkg.engines.node).toBe('>=20.0.0');
    expect(pkg.keywords).toEqual(expect.arrayContaining(['node-red', 'mcp', 'ai']));
    expect(pkg.scripts.prepublishOnly).toMatch(/quality.*test.*build:prod/);
  });
});

describe('MCP SDK validateToolInput override', () => {
  it('SDK McpServer still exposes validateToolInput (canary for the override)', () => {
    const server = new McpServer({ name: 't', version: '0' });
    expect(typeof (server as unknown as { validateToolInput?: unknown }).validateToolInput).toBe(
      'function'
    );
  });

  it('falls back to SDK behaviour when validateToolInput is missing', () => {
    const fake = {} as unknown as McpServer;
    expect(() => installMcpArgumentErrorMapping(fake)).not.toThrow();
    expect((fake as unknown as { validateToolInput?: unknown }).validateToolInput).toBeUndefined();
  });
});
