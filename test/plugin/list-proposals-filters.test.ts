/**
 * Proposal list filters (status, mine, flowId) and limit/offset pagination
 * across REST, GET link, and MCP.
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

function createApp(userDir: string): { app: Express; linkStore: AccessLinkStore } {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 20 });

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

  const adapter: FlowAdapter = {
    kind: 'red',
    getFlows: () =>
      Promise.resolve({
        rev: 'rev-1',
        flows: [
          { id: 'tab-1', type: 'tab', label: 'Main' },
          { id: 'tab-2', type: 'tab', label: 'Other' },
          { id: 'n1', type: 'inject', z: 'tab-1' },
          { id: 'n2', type: 'inject', z: 'tab-2' },
        ],
      }),
    getFlow: (id: string) =>
      Promise.resolve({
        rev: 'rev-1',
        flow: {
          id,
          type: 'tab',
          label: id === 'tab-2' ? 'Other' : 'Main',
          nodes: [
            { id: id === 'tab-2' ? 'n2' : 'n1', type: 'inject', name: 'tick', z: id, wires: [[]] },
          ],
          configs: [],
        },
      }),
    updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
  };

  registerRoutes(RED, { linkStore, flowAdapter: adapter });
  return { app, linkStore };
}

async function callTool(
  app: Express,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await request(app)
    .post('/mcp/rpc')
    .set('Accept', MCP_ACCEPT)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
  expect(res.status).toBe(200);
  expect(res.body.error).toBeUndefined();
  const result = res.body.result as
    { content?: { type: string; text: string }[]; isError?: boolean } | undefined;
  expect(result?.isError).not.toBe(true);
  return JSON.parse(String(result?.content?.[0]?.text ?? '{}')) as Record<string, unknown>;
}

describe('list proposals filters and pagination', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-list-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  async function seedThree(app: Express, linkStore: AccessLinkStore) {
    const rest = linkStore.create({ label: 'rest', kind: 'rest' });
    const other = linkStore.create({ label: 'other', kind: 'rest' });
    const getLink = linkStore.create({ label: 'get', kind: 'get_link' });
    const mcp = linkStore.create({ label: 'mcp', kind: 'mcp' });

    const a = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${rest.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'tab1-a',
        payload: { flowId: 'tab-1', nodes: [{ op: 'set', id: 'n1', set: { name: 'A' } }] },
      });
    expect(a.status).toBe(201);

    const b = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${other.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'tab2-b',
        payload: { flowId: 'tab-2', nodes: [{ op: 'set', id: 'n2', set: { name: 'B' } }] },
      });
    expect(b.status).toBe(201);

    const c = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${rest.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'tab1-c',
        payload: { flowId: 'tab-1', nodes: [{ op: 'set', id: 'n1', set: { name: 'C' } }] },
      });
    expect(c.status).toBe(201);

    // Withdraw one so status filter has a non-pending row.
    const withdrawn = await request(app)
      .post(`/mcp/api/v1/proposals/${b.body.id}/withdraw`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({ reason: 'done' });
    expect(withdrawn.status).toBe(200);

    return {
      rest,
      other,
      getLink,
      mcp,
      ids: { a: a.body.id as string, b: b.body.id as string, c: c.body.id as string },
    };
  }

  it('REST filters by status, flowId, mine and paginates with total', async () => {
    const { app, linkStore } = createApp(userDir);
    const { rest, ids } = await seedThree(app, linkStore);
    const auth = { Authorization: `Bearer ${rest.token}` };

    const all = await request(app).get('/mcp/api/v1/proposals').set(auth);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.proposals).toHaveLength(3);

    const pending = await request(app).get('/mcp/api/v1/proposals?status=pending').set(auth);
    expect(pending.body.total).toBe(2);
    expect(pending.body.proposals.every((p: { status: string }) => p.status === 'pending')).toBe(
      true
    );

    const withdrawn = await request(app).get('/mcp/api/v1/proposals?status=withdrawn').set(auth);
    expect(withdrawn.body.total).toBe(1);
    expect(withdrawn.body.proposals[0].id).toBe(ids.b);

    const tab1 = await request(app).get('/mcp/api/v1/proposals?flowId=tab-1').set(auth);
    expect(tab1.body.total).toBe(2);
    const tab1Ids = new Set(tab1.body.proposals.map((p: { id: string }) => p.id));
    expect(tab1Ids.has(ids.a)).toBe(true);
    expect(tab1Ids.has(ids.c)).toBe(true);
    expect(tab1Ids.has(ids.b)).toBe(false);

    const mine = await request(app).get('/mcp/api/v1/proposals?mine=true').set(auth);
    expect(mine.body.total).toBe(2);

    const page = await request(app).get('/mcp/api/v1/proposals?limit=1&offset=1').set(auth);
    expect(page.body.total).toBe(3);
    expect(page.body.limit).toBe(1);
    expect(page.body.offset).toBe(1);
    expect(page.body.proposals).toHaveLength(1);
  });

  it('GET link applies the same status/flowId/limit filters', async () => {
    const { app, linkStore } = createApp(userDir);
    const { getLink, ids } = await seedThree(app, linkStore);
    const base = `/mcp/a/${getLink.token}`;

    const pending = await request(app).get(`${base}/proposals?status=pending&flowId=tab-1`);
    expect(pending.status).toBe(200);
    expect(pending.body.total).toBe(2);
    expect(pending.body.proposals).toHaveLength(2);

    const page = await request(app).get(`${base}/proposals?limit=1&offset=0&status=withdrawn`);
    expect(page.body.total).toBe(1);
    expect(page.body.proposals).toHaveLength(1);
    expect(page.body.proposals[0].id).toBe(ids.b);
    expect(page.body.limit).toBe(1);
  });

  it('MCP list_proposals filters and paginates; alias still works', async () => {
    const { app, linkStore } = createApp(userDir);
    const { mcp, ids } = await seedThree(app, linkStore);

    const byStatus = await callTool(app, mcp.token, 'list_proposals', { status: 'withdrawn' });
    expect(byStatus.total).toBe(1);
    expect((byStatus.proposals as { id: string }[])[0]!.id).toBe(ids.b);

    const byFlow = await callTool(app, mcp.token, 'list_proposals', { flowId: 'tab-2' });
    expect(byFlow.total).toBe(1);
    expect((byFlow.proposals as { id: string }[])[0]!.id).toBe(ids.b);

    const page = await callTool(app, mcp.token, 'list_proposals', { limit: 1, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.limit).toBe(1);
    expect((page.proposals as unknown[]).length).toBe(1);

    const alias = await callTool(app, mcp.token, 'list_my_proposals', {
      status: 'pending',
      flowId: 'tab-1',
    });
    expect(alias.total).toBe(2);
  });
});
