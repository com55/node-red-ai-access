/**
 * List filters (invalid_filter on GET/REST/MCP), pagination fields,
 * duplicate_node_id, validation_failed, autoClosedCount, MCP argument mapping.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import { installMcpArgumentErrorMapping } from '../../src/plugin/mcp-rpc.js';
import { schemaTypeText } from '../../src/plugin/mcp-tools-doc.js';
import { renderMcpPage } from '../../src/plugin/page.js';
import {
  autoGenerateProposalTitle,
  buildReplaceFlowTitle,
  shouldRefreshDisplayTitle,
  titleFromDiffSummary,
} from '../../src/plugin/proposal-present.js';
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

  it('keeps proposals open when the global revision moves', async () => {
    const { app, linkStore, setRev } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest' });
    const first = await submitRest(app, link.token, 'old');
    expect(first.status).toBe(201);
    expect(first.body).not.toHaveProperty('staleOnOlderRev');
    expect(first.body).not.toHaveProperty('autoClosedCount');

    // Live rev moves: the next list rebases the open proposal.
    setRev('rev-9');
    const listed = await request(app)
      .get('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`);
    expect(listed.status).toBe(200);
    expect(listed.body).not.toHaveProperty('autoClosedCount');
    expect(listed.body.proposals[0].status).toBe('pending');
    expect(listed.body.proposals[0].rebase.state).toBe('clean');
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
    // Expire a proposal by age, then create a fresh pending proposal.
    expect((await submitRest(h.app, token, 'a')).status).toBe(201);
    const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 86_400_000);
    await request(h.app).get('/mcp/api/v1/proposals').set('Authorization', `Bearer ${token}`);
    time.mockRestore();
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

  it('package ships the whole docs/ folder (incl. README and api/openapi.yaml); no maps', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      files: string[];
      engines: { node: string };
      keywords: string[];
      scripts: Record<string, string>;
    };
    expect(pkg.files).toContain('docs');
    expect(pkg.files).toContain('!dist/**/*.map');
    expect(pkg.files.some(f => f.startsWith('!docs'))).toBe(false);
    expect(pkg.engines.node).toBe('>=20.19.0');
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

describe('status filter messages and packaging follow-ups', () => {
  let userDir: string;
  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-status-msg-'));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('MCP invalid status array uses the same message as REST/GET', async () => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const getLink = linkStore.create({ kind: 'get_link' });
    const mcp = linkStore.create({ kind: 'mcp' });
    const r = await request(app)
      .get('/mcp/api/v1/proposals?status=pending&status=bogus')
      .set('Authorization', `Bearer ${rest.token}`);
    const g = await request(app).get(`/mcp/a/${getLink.token}/proposals?status=pending,bogus`);
    const m = await callTool(app, mcp.token, 'list_proposals', { status: ['pending', 'bogus'] });
    expect(r.body.error).not.toMatch(/at most once/);
    expect(m.json.error).toBe(r.body.error);
    expect(g.body.error).toBe(r.body.error);
    expect(m.json.hint).toBe(r.body.hint);
  });

  it('single-value filters keep the "at most once" message when repeated', async () => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const r = await request(app)
      .get('/mcp/api/v1/proposals?offset=0&offset=1')
      .set('Authorization', `Bearer ${rest.token}`);
    expect(r.body).toMatchObject({ code: 'invalid_filter', parameter: 'offset' });
    expect(r.body.error).toMatch(/at most once/);
  });

  it('MCP status [] (and "") means no status filter', async () => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const mcp = linkStore.create({ kind: 'mcp' });
    expect((await submitRest(app, rest.token, 'a')).status).toBe(201);
    const all = await callTool(app, mcp.token, 'list_proposals', {});
    for (const status of [[], '']) {
      const out = await callTool(app, mcp.token, 'list_proposals', { status });
      expect(out.isError).toBe(false);
      expect(out.json.total).toBe(all.json.total);
    }
  });

  it('OpenAPI is resolved from docs/api (single copy, no dist duplicate)', async () => {
    const { resolveOpenApiYamlPath } = await import('../../src/plugin/openapi.js');
    expect(resolveOpenApiYamlPath()?.replace(/\\/g, '/')).toMatch(/docs\/api\/openapi\.yaml$/);
    const tsup = readFileSync(join(__dirname, '../../tsup.config.ts'), 'utf8');
    expect(tsup).not.toMatch(/copyFileSync/);
  });
});

describe('proposal presentation is consistent across channels', () => {
  let userDir: string;
  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-present-'));
    // Legacy proposal: no flow label stored anywhere, no baseFlow.
    const dir = join(userDir, '.ai-access', 'proposals');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'prop-legacy0000000000000001.json'),
      JSON.stringify({
        id: 'prop-legacy0000000000000001',
        type: 'replace_flow',
        status: 'expired',
        expectedRev: 'x',
        payload: { flowId: 'tab-1', flow: { id: 'tab-1', nodes: [] } },
        createdBy: { kind: 'access-link', linkId: 'old', label: 'old' },
        createdAt: '2026-10-15T14:59:41.370Z',
        updatedAt: '2026-10-15T14:59:41.370Z',
        baseFlow: null,
      })
    );
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('list and single reads on REST, GET link, MCP, and admin agree on flowLabel/title', async () => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const getLink = linkStore.create({ kind: 'get_link' });
    const mcp = linkStore.create({ kind: 'mcp' });
    const id = 'prop-legacy0000000000000001';
    const auth = { Authorization: `Bearer ${rest.token}` };
    const results: { flowLabel: unknown; title: unknown }[] = [];
    const pick = (p: Record<string, unknown>) => ({ flowLabel: p.flowLabel, title: p.title });
    const restList = await request(app).get('/mcp/api/v1/proposals').set(auth);
    results.push(pick(restList.body.proposals[0]));
    results.push(pick((await request(app).get(`/mcp/api/v1/proposals/${id}`).set(auth)).body));
    results.push(pick((await request(app).get('/mcp/api/v1/proposals')).body.proposals[0]));
    results.push(pick((await request(app).get(`/mcp/api/v1/proposals/${id}`)).body));
    const gl = await request(app).get(`/mcp/a/${getLink.token}/proposals`);
    results.push(pick(gl.body.proposals[0]));
    results.push(pick((await request(app).get(`/mcp/a/${getLink.token}/proposals/${id}`)).body));
    const ml = await callTool(app, mcp.token, 'list_proposals', {});
    results.push(pick((ml.json.proposals as Record<string, unknown>[])[0]!));
    const mg = await callTool(app, mcp.token, 'get_proposal', { id });
    results.push(pick(mg.json));
    for (const r of results) {
      expect(r).toEqual({ flowLabel: 'Main', title: 'Update Main' });
    }
  });
});

describe('titles never render a non-string node type', () => {
  it('buildReplaceFlowTitle / autoGenerateProposalTitle fall back to "node"', () => {
    const t = buildReplaceFlowTitle({
      flowLabel: 'Test Flow',
      removed: 4,
      added: [{ id: 'q', type: { x: 1 } as unknown as string }],
    });
    expect(t).toBe('Replace Test Flow: deletes 4 nodes, adds 1 node');
    const auto = autoGenerateProposalTitle({ id: 't', type: 'tab', label: 'L', nodes: [] }, {
      id: 't',
      type: 'tab',
      label: 'L',
      nodes: [{ id: 'q', type: { x: 1 } }],
    } as never);
    expect(auto).not.toMatch(/object Object/);
  });

  it('titleFromDiffSummary ignores a non-string firstAddedType', () => {
    const t = titleFromDiffSummary(
      { removed: 1, added: 1 },
      { flowLabel: 'F', firstAddedType: { x: 1 } as unknown as string }
    );
    expect(t).toBe('Replace F: deletes 1 node, adds 1 node');
  });

  it('stored legacy "[object Object]" titles are regenerated on read', () => {
    expect(shouldRefreshDisplayTitle('Replace F: deletes 4 nodes, adds 1 [object Object]', 4)).toBe(
      true
    );
  });

  it('page client guards the same cases', () => {
    const html = renderMcpPage({ apiBase: '/mcp/api/v1' } as never);
    expect(html).toContain("t.indexOf('[object Object]') !== -1");
    expect(html).toContain("typeof diff.added[0].type === 'string'");
  });
});

describe('/mcp page UI follow-ups', () => {
  const html = renderMcpPage({ apiBase: '/mcp/api/v1' } as never);

  it('Decided list pages with Load more and searches beyond the first page', () => {
    expect(html).toContain('DECIDED_PAGE_SIZE = 50');
    expect(html).toContain("'&limit=' + DECIDED_PAGE_SIZE + '&offset=' + decidedLoaded");
    expect(html).toContain('id="decided-load-more"');
    expect(html).toContain('Load more');
    expect(html).toContain('loadAllDecidedForSearch()');
    expect(html).toContain("api('/proposals?status=pending')");
  });

  it('copy short-id buttons have an accessible name', () => {
    expect(html).toContain('aria-label="Copy proposal id \' + esc(s) + \'"');
  });

  it('Custom TTL option is labelled "Custom…" and the row has no offset margin', () => {
    expect(html).toContain('<option value="custom">Custom…</option>');
    expect(html).toMatch(/\.ttl-custom-row \{[^}]*margin: 0;[^}]*align-self: flex-end;/);
  });

  it('toast sits bottom-left, clear of right-aligned table actions', () => {
    expect(html).toMatch(/\.toast-host \{[^}]*left: 1rem;/);
    expect(html).not.toMatch(/\.toast-host \{[^}]*right: 1rem;/);
  });

  it('"For developers" is collapsed on each new token', () => {
    expect(html).toContain("var devDetails = $('token-dev-details');");
    expect(html).toContain('devDetails.open = false;');
  });
});

describe('mcp-tools.md type rendering', () => {
  it('renders unions, enums, and arrays instead of "unknown"', () => {
    expect(
      schemaTypeText({ anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] })
    ).toBe('string | string[]');
    expect(schemaTypeText({ type: 'string', enum: ['a', 'b'] })).toBe('"a" | "b"');
    expect(schemaTypeText({ type: 'array', items: { enum: ['x', 'y'] } })).toBe('("x" | "y")[]');
    expect(schemaTypeText({})).toBe('any');
    const doc = readFileSync(join(__dirname, '../../docs/mcp-tools.md'), 'utf8');
    expect(doc).not.toMatch(/\| unknown \|/);
  });
});

describe('submit responses carry the stored title and flowLabel', () => {
  let userDir: string;
  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-stored-title-'));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  const expected = {
    title: 'Tweak greeting in Main',
    storedTitle: 'Tweak greeting',
    flowLabel: 'Main',
  };
  const pick = (b: Record<string, unknown>) => ({
    title: b.title,
    storedTitle: b.storedTitle,
    flowLabel: b.flowLabel,
  });

  it('REST create, then read, agree on storedTitle/title/flowLabel', async () => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const res = await submitRest(app, rest.token, 'Tweak greeting', 'hi');
    expect(res.status).toBe(201);
    expect(pick(res.body)).toEqual(expected);
    const read = await request(app)
      .get(`/mcp/api/v1/proposals/${res.body.id}`)
      .set('Authorization', `Bearer ${rest.token}`);
    expect(pick(read.body)).toEqual(expected);
  });

  it('MCP submit_proposal returns storedTitle exactly as stored', async () => {
    const { app, linkStore } = createApp(userDir);
    const mcp = linkStore.create({ kind: 'mcp' });
    const out = await callTool(app, mcp.token, 'submit_proposal', {
      type: 'replace_flow',
      expectedRev: 'rev-1',
      title: 'Tweak greeting',
      payload: { flowId: 'tab-1', nodes: [{ op: 'set', id: 'n1', set: { name: 'hi' } }] },
    });
    expect(out.isError).toBe(false);
    expect(pick(out.json)).toEqual(expected);
  });

  it('GET-link propose returns storedTitle exactly as stored', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link' });
    const patch = b64({ nodes: [{ op: 'set', id: 'n1', set: { name: 'hi' } }] });
    const res = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&title=${encodeURIComponent('Tweak greeting')}&patch=${patch}`
    );
    expect(res.status).toBe(201);
    expect(pick(res.body.proposal)).toEqual(expected);
  });

  it('a title that already names the flow is unchanged in both fields', async () => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const res = await submitRest(app, rest.token, 'Fix Main greeting', 'x');
    expect(res.body.title).toBe('Fix Main greeting');
    expect(res.body.storedTitle).toBe('Fix Main greeting');
  });
});

describe('RateLimit headers and openapi.json', () => {
  let userDir: string;
  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-rl-'));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it.each([
    '/mcp/api/v1',
    '/mcp/api/v1/openapi.yaml',
    '/mcp/api/v1/openapi.json',
    '/mcp/api/v1/status',
    '/mcp/api/v1/proposals',
    '/mcp/api/v1/logs',
    '/mcp/api/v1/links',
    '/mcp/api/v1/settings',
  ])('token request to %s reports the per-token policy', async path => {
    const { app, linkStore } = createApp(userDir);
    const rest = linkStore.create({ kind: 'rest' });
    const res = await request(app).get(path).set('Authorization', `Bearer ${rest.token}`);
    expect(res.headers['ratelimit-policy']).toBe('300;w=60');
    expect(res.headers['ratelimit-limit']).toBe('300');
  });

  it('GET-link and MCP requests report the per-token policy', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link' });
    const g = await request(app).get(`/mcp/a/${link.token}/status`);
    expect(g.headers['ratelimit-policy']).toBe('300;w=60');
    const mcp = linkStore.create({ kind: 'mcp' });
    const m = await request(app)
      .post('/mcp/rpc')
      .set('Authorization', `Bearer ${mcp.token}`)
      .set('Accept', MCP_ACCEPT)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(m.headers['ratelimit-policy']).toBe('300;w=60');
  });

  it('requests without a token report the per-IP policy', async () => {
    const { app } = createApp(userDir);
    const res = await request(app).get('/mcp/api/v1/openapi.yaml');
    expect(res.headers['ratelimit-policy']).toBe('600;w=60');
  });

  it('serves openapi.json equal to the YAML spec, and discovery links it', async () => {
    const { app } = createApp(userDir);
    const json = await request(app).get('/mcp/api/v1/openapi.json');
    expect(json.status).toBe(200);
    expect(json.headers['content-type']).toMatch(/application\/json/);
    const yamlText = readFileSync(join(__dirname, '../../docs/api/openapi.yaml'), 'utf8');
    expect(json.body).toEqual(parseYaml(yamlText));
    expect(json.body.paths['/openapi.json']).toBeDefined();
    const disc = await request(app).get('/mcp/api/v1');
    expect(disc.body.openapiJson).toBe('/mcp/api/v1/openapi.json');
    expect((disc.body.endpoints as { path: string }[]).some(e => e.path === '/openapi.json')).toBe(
      true
    );
  });

  it('GET guide links the JSON spec and documents the header policy', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link' });
    const docs = await request(app).get(`/mcp/a/${link.token}`);
    expect(docs.text).toContain('/mcp/api/v1/openapi.json');
    expect(docs.text).toContain('RateLimit-Policy: 300;w=60');
  });

  it('storedTitle wording explains the auto-generated case', () => {
    const spec = readFileSync(join(__dirname, '../../docs/api/openapi.yaml'), 'utf8');
    expect(spec).toMatch(/storedTitle:[\s\S]*?may already contain the flow name/);
  });
});
