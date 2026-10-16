/**
 * Proposal visibility (all tokens + mine), cross-token conflicts, withdraw.
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
          { id: 'n1', type: 'inject', z: 'tab-1' },
          { id: 'n2', type: 'template', z: 'tab-1' },
        ],
      }),
    getFlow: (id: string) =>
      Promise.resolve({
        rev: 'rev-1',
        flow: {
          id,
          type: 'tab',
          label: 'Main',
          nodes: [
            { id: 'n1', type: 'inject', name: 'tick', z: id, wires: [[]] },
            { id: 'n2', type: 'template', name: 'tpl', z: id, template: 'Hello', wires: [[]] },
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
): Promise<{ status: number; body: Record<string, unknown> }> {
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
  return { status: res.status, body: res.body as Record<string, unknown> };
}

function parseToolJson(rpcBody: Record<string, unknown>): Record<string, unknown> {
  expect(rpcBody.error).toBeUndefined();
  const result = rpcBody.result as
    { content?: { type: string; text: string }[]; isError?: boolean } | undefined;
  expect(result?.isError).not.toBe(true);
  const content = result?.content?.[0];
  expect(content?.type).toBe('text');
  return JSON.parse(String(content?.text ?? '{}')) as Record<string, unknown>;
}

describe('proposal visibility, conflicts, withdraw', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-vis-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('lists all proposals with mine flags; mine=true filters', async () => {
    const { app, linkStore } = createApp(userDir);
    const linkA = linkStore.create({ label: 'a', kind: 'rest' });
    const linkB = linkStore.create({ label: 'b', kind: 'rest' });

    const fromA = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${linkA.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'from-a',
        payload: {
          flowId: 'tab-1',
          nodes: [{ op: 'set', id: 'n1', set: { name: 'A' } }],
        },
      });
    expect(fromA.status).toBe(201);
    expect(fromA.body.mine).toBe(true);

    const fromB = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${linkB.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'from-b',
        payload: {
          flowId: 'tab-1',
          nodes: [{ op: 'set', id: 'n2', set: { name: 'B' } }],
        },
      });
    expect(fromB.status).toBe(201);

    const listB = await request(app)
      .get('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${linkB.token}`);
    expect(listB.status).toBe(200);
    expect(listB.body.proposals).toHaveLength(2);
    const mines = Object.fromEntries(
      listB.body.proposals.map((p: { id: string; mine: boolean }) => [p.id, p.mine])
    );
    expect(mines[fromA.body.id]).toBe(false);
    expect(mines[fromB.body.id]).toBe(true);

    const onlyMine = await request(app)
      .get('/mcp/api/v1/proposals?mine=true')
      .set('Authorization', `Bearer ${linkB.token}`);
    expect(onlyMine.body.proposals).toHaveLength(1);
    expect(onlyMine.body.proposals[0].id).toBe(fromB.body.id);
    expect(onlyMine.body.proposals[0].mine).toBe(true);

    const getOther = await request(app)
      .get(`/mcp/api/v1/proposals/${fromA.body.id}`)
      .set('Authorization', `Bearer ${linkB.token}`);
    expect(getOther.status).toBe(200);
    expect(getOther.body.mine).toBe(false);
    expect(getOther.body.id).toBe(fromA.body.id);
  });

  it('reports conflictingProposals across tokens with overlapping nodes/fields', async () => {
    const { app, linkStore } = createApp(userDir);
    const linkA = linkStore.create({ label: 'ca', kind: 'get_link' });
    const linkB = linkStore.create({ label: 'cb', kind: 'get_link' });

    const fromA = await request(app).get(
      `/mcp/a/${linkA.token}/propose?flow=tab-1&rev=rev-1&node=n1&set.name=A&title=from-a`
    );
    expect(fromA.status).toBe(201);

    const fromB = await request(app).get(
      `/mcp/a/${linkB.token}/propose?flow=tab-1&rev=rev-1&node=n1&set.name=B&title=from-b`
    );
    expect(fromB.status).toBe(201);
    expect(fromB.body.conflictingProposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fromA.body.proposal.id,
          mine: false,
          overlappingNodeIds: expect.arrayContaining(['n1']),
        }),
      ])
    );
    expect(fromB.body.otherLinkSiblingCount).toBeUndefined();
    expect(String(fromB.body.warning)).toMatch(/conflict|same flow/i);

    const readA = await request(app).get(
      `/mcp/a/${linkA.token}/proposals/${fromA.body.proposal.id}`
    );
    expect(readA.status).toBe(200);
    expect(readA.body.conflictingProposals).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fromB.body.proposal.id, mine: false })])
    );
  });

  it('withdraws own pending proposal on REST, GET, and MCP; blocks others', async () => {
    const { app, linkStore } = createApp(userDir);
    const linkA = linkStore.create({ label: 'wa', kind: 'rest' });
    const linkB = linkStore.create({ label: 'wb', kind: 'rest' });
    const getLink = linkStore.create({ label: 'wg', kind: 'get_link' });
    const mcpLink = linkStore.create({ label: 'wm', kind: 'mcp' });

    const created = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${linkA.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'to-withdraw',
        payload: {
          flowId: 'tab-1',
          nodes: [{ op: 'set', id: 'n1', set: { name: 'X' } }],
        },
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const denied = await request(app)
      .post(`/mcp/api/v1/proposals/${id}/withdraw`)
      .set('Authorization', `Bearer ${linkB.token}`)
      .send({ reason: 'nope' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('proposal_not_owned');

    const withdrawn = await request(app)
      .post(`/mcp/api/v1/proposals/${id}/withdraw`)
      .set('Authorization', `Bearer ${linkA.token}`)
      .send({ reason: 'changed my mind' });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe('withdrawn');
    expect(withdrawn.body.reason).toMatch(/changed my mind/);
    expect(withdrawn.body.decidedBy).toEqual(
      expect.objectContaining({ kind: 'access-link', linkId: linkA.id })
    );

    const again = await request(app)
      .post(`/mcp/api/v1/proposals/${id}/withdraw`)
      .set('Authorization', `Bearer ${linkA.token}`)
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('proposal_not_pending');

    const gCreated = await request(app).get(
      `/mcp/a/${getLink.token}/propose?flow=tab-1&rev=rev-1&node=n1&set.name=G&title=g-withdraw`
    );
    expect(gCreated.status).toBe(201);
    const gId = gCreated.body.proposal.id as string;
    const gWithdraw = await request(app).get(
      `/mcp/a/${getLink.token}/proposals/${gId}/withdraw?confirm=1&reason=done`
    );
    expect(gWithdraw.status).toBe(200);
    expect(gWithdraw.body.status).toBe('withdrawn');

    const mcpCreated = await callTool(app, mcpLink.token, 'submit_proposal', {
      type: 'replace_flow',
      expectedRev: 'rev-1',
      title: 'mcp-w',
      payload: {
        flowId: 'tab-1',
        nodes: [{ op: 'set', id: 'n1', set: { name: 'M' } }],
      },
    });
    expect(mcpCreated.status).toBe(200);
    const mcpBody = parseToolJson(mcpCreated.body);
    expect(mcpBody.status).toBe('pending');
    const mcpId = String(mcpBody.id);

    const mcpWithdraw = await callTool(app, mcpLink.token, 'withdraw_proposal', {
      id: mcpId,
      reason: 'mcp done',
    });
    expect(mcpWithdraw.status).toBe(200);
    const mcpOut = parseToolJson(mcpWithdraw.body);
    expect(mcpOut.status).toBe('withdrawn');
    expect(mcpOut.mine).toBe(true);
  });

  it('documents 1.5MB cap, known issues, and nodes shapes on GET docs', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ label: 'docs', kind: 'get_link' });
    const docs = await request(app).get(`/mcp/a/${link.token}`);
    expect(docs.status).toBe(200);
    expect(docs.text).toMatch(/1_500_000|1500000/);
    expect(docs.text).toMatch(/every.*channel|on \*\*every\*\* channel/i);
    expect(docs.text).toMatch(/Known issues/i);
    expect(docs.text).toMatch(/Several tokens can each use the full/i);
    expect(docs.text).toMatch(/conflictingProposals/);
    expect(docs.text).toMatch(/withdraw/);
    expect(docs.text).toMatch(/replace_text/);
    expect(docs.text).toMatch(/payload\.nodes|Canonical/);
    expect(docs.text).toMatch(/Git mental model/i);
    expect(docs.text).toMatch(/pull request/i);
  });

  it('MCP list_my_proposals returns all with mine filter', async () => {
    const { app, linkStore } = createApp(userDir);
    const a = linkStore.create({ label: 'ma', kind: 'mcp' });
    const b = linkStore.create({ label: 'mb', kind: 'mcp' });

    await callTool(app, a.token, 'submit_proposal', {
      type: 'replace_flow',
      expectedRev: 'rev-1',
      title: 'a1',
      payload: { flowId: 'tab-1', nodes: [{ op: 'set', id: 'n1', set: { name: 'A' } }] },
    });
    await callTool(app, b.token, 'submit_proposal', {
      type: 'replace_flow',
      expectedRev: 'rev-1',
      title: 'b1',
      payload: { flowId: 'tab-1', nodes: [{ op: 'set', id: 'n2', set: { name: 'B' } }] },
    });

    const allRes = await callTool(app, b.token, 'list_my_proposals');
    const all = parseToolJson(allRes.body);
    expect((all.proposals as unknown[]).length).toBe(2);

    const mineRes = await callTool(app, b.token, 'list_my_proposals', { mine: true });
    const mineOnly = parseToolJson(mineRes.body);
    expect((mineOnly.proposals as unknown[]).length).toBe(1);
    expect((mineOnly.proposals as { mine: boolean }[])[0]!.mine).toBe(true);
  });
});
