/**
 * HTTP tests for proposals, flows, and logs routes.
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
import { FlowRevisionConflictError } from '../../src/runtime/errors.js';
import type { FlowAdapter } from '../../src/runtime/types.js';

interface MockUser {
  username: string;
  permissions: string | string[];
}

function createApp(options: {
  userDir: string;
  authenticate?: (req: Request, _res: Response, next: NextFunction) => void;
  adapter?: FlowAdapter;
  linkStore?: AccessLinkStore;
}): { app: Express; RED: NodeRedPluginAPI; linkStore: AccessLinkStore } {
  const app = express();
  app.use(express.json());

  const authenticate =
    options.authenticate ??
    ((_req: Request, _res: Response, next: NextFunction) => {
      next();
    });

  const linkStore = options.linkStore ?? new AccessLinkStore({ maxActiveLinks: 10 });

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir: options.userDir,
      httpAdminRoot: '/',
      adminAuth: { type: 'credentials' },
      aiAccess: { defaultDeploymentType: 'nodes' },
    },
    httpAdmin: app,
    auth: {
      needsPermission(permission: string) {
        return (req: Request, res: Response, next: NextFunction) => {
          authenticate(req, res, (err?: unknown) => {
            if (err) {
              next(err as Error);
              return;
            }
            const user = (req as Request & { user?: MockUser }).user;
            if (!user) {
              next();
              return;
            }
            const scopes = Array.isArray(user.permissions) ? user.permissions : [user.permissions];
            const allowed =
              scopes.includes('*') ||
              scopes.includes(permission) ||
              (permission === 'read' && scopes.includes('read'));
            if (!allowed) {
              res.status(401).end();
              return;
            }
            next();
          });
        };
      },
    },
    plugins: {
      registerPlugin() {
        // unused — registerRoutes called directly
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  const adapter: FlowAdapter =
    options.adapter ??
    ({
      kind: 'red',
      getFlows: () =>
        Promise.resolve({
          rev: 'rev-1',
          flows: [
            { id: 'tab-1', type: 'tab', label: 'Main' },
            { id: 'n1', type: 'inject', z: 'tab-1' },
          ],
        }),
      getFlow: () =>
        Promise.resolve({
          rev: 'rev-1',
          flow: { id: 'tab-1', type: 'tab', label: 'Main', nodes: [{ id: 'n1', type: 'inject' }] },
        }),
      updateFlow: () => Promise.resolve({ flowId: 'tab-1', rev: 'rev-2' }),
    } satisfies FlowAdapter);

  registerRoutes(RED, { flowAdapter: adapter, linkStore });
  return { app, RED, linkStore };
}

function asUser(permissions: string | string[], username = 'user') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    (req as Request & { user?: MockUser }).user = { username, permissions };
    next();
  };
}

describe('proposals / flows / logs HTTP API', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-http-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('approve accepts deploymentType override in the body', async () => {
    const updateFlow = vi.fn(async () => ({ rev: 'rev-9' }));
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('*', 'admin'),
      adapter: {
        kind: 'red',
        getFlows: () => Promise.resolve({ rev: 'rev-1', flows: [] }),
        getFlow: () =>
          Promise.resolve({
            rev: 'rev-1',
            flow: { id: 'tab-1', type: 'tab', nodes: [] },
          }),
        updateFlow,
      },
    });
    const createdLink = linkStore.create({ kind: 'rest', label: 'deploy-type' });
    const created = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${createdLink.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', flow: { id: 'tab-1', type: 'tab', nodes: [] } },
      });
    expect(created.status).toBe(201);

    const approved = await request(app)
      .post(`/mcp/api/v1/proposals/${created.body.id}/approve`)
      .send({ deploymentType: 'full' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(updateFlow).toHaveBeenCalledWith(expect.objectContaining({ deploymentType: 'full' }));
  });

  it('access link can read flows (with rev), create proposal; * can approve', async () => {
    const updateFlow = vi.fn(() => Promise.resolve({ flowId: 'tab-1', rev: 'rev-2' }));
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('*', 'admin'),
      adapter: {
        kind: 'red',
        getFlows: () =>
          Promise.resolve({
            rev: 'rev-1',
            flows: [{ id: 'tab-1', type: 'tab', label: 'Main' }],
          }),
        getFlow: () =>
          Promise.resolve({
            rev: 'rev-1',
            flow: { id: 'tab-1', type: 'tab', nodes: [] },
          }),
        updateFlow,
      },
    });

    const link = linkStore.create({ kind: 'rest', label: 'agent' });

    const flows = await request(app)
      .get('/mcp/api/v1/flows')
      .set('Authorization', `Bearer ${link.token}`);
    expect(flows.status).toBe(200);
    expect(flows.body.rev).toBe('rev-1');

    const created = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: {
          flowId: 'tab-1',
          flow: { id: 'tab-1', type: 'tab', label: 'Main', nodes: [{ id: 'n1', type: 'inject' }] },
        },
      });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');
    expect(created.body.title).toBeTruthy();
    expect(created.body.displayName).toContain(created.body.title);
    expect(created.body.displayName).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(created.body.reviewPath).toBe(`/mcp#proposal=${created.body.id}`);
    expect(created.body.reviewUrl).toMatch(new RegExp(`/mcp#proposal=${created.body.id}$`));

    const withTitle = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .set('Host', 'nr.example:1880')
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'Add inject sensor',
        payload: {
          flowId: 'tab-1',
          flow: {
            id: 'tab-1',
            type: 'tab',
            label: 'Main',
            nodes: [{ id: 'n2', type: 'inject', name: 'sensor' }],
          },
        },
      });
    expect(withTitle.status).toBe(201);
    expect(withTitle.body.title).toBe('Add inject sensor in Main');
    expect(withTitle.body.displayName.startsWith('Add inject sensor in Main · ')).toBe(true);
    expect(withTitle.body.reviewPath).toBe(`/mcp#proposal=${withTitle.body.id}`);
    expect(withTitle.body.reviewUrl).toBe(
      `http://nr.example:1880/mcp#proposal=${withTitle.body.id}`
    );

    const listed = await request(app)
      .get('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`);
    expect(listed.status).toBe(200);
    expect(
      listed.body.proposals.every(
        (p: { displayName?: string; reviewUrl?: string; reviewPath?: string }) =>
          Boolean(p.displayName && p.reviewUrl && p.reviewPath)
      )
    ).toBe(true);

    const approved = await request(app).post(`/mcp/api/v1/proposals/${created.body.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.displayName).toBeTruthy();
    expect(updateFlow).toHaveBeenCalledOnce();

    const logs = await request(app).get('/mcp/api/v1/logs');
    expect(logs.status).toBe(200);
    expect(logs.body.logs.some((e: { action: string }) => e.action === 'proposal.approved')).toBe(
      true
    );
    const createdLog = logs.body.logs.find(
      (e: { action: string }) => e.action === 'proposal.created'
    );
    expect(createdLog?.details?.displayName).toBeTruthy();
  });

  it('lists pending proposals with baseRevStale and flowLabel (never raw tab id as label)', async () => {
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('*', 'admin'),
      adapter: {
        kind: 'red',
        getFlows: () =>
          Promise.resolve({
            rev: 'rev-live',
            flows: [{ id: 'tab-1', type: 'tab', label: 'Test Flow' }],
          }),
        getFlow: () =>
          Promise.resolve({
            rev: 'rev-live',
            flow: { id: 'tab-1', type: 'tab', label: 'Test Flow', nodes: [] },
          }),
        updateFlow: () => Promise.resolve({ flowId: 'tab-1', rev: 'rev-next' }),
      },
    });
    const link = linkStore.create({ kind: 'rest', label: 'agent' });
    const created = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-live',
        payload: {
          flowId: 'tab-1',
          flow: { id: 'tab-1', type: 'tab', label: 'Test Flow', nodes: [] },
        },
      });
    expect(created.status).toBe(201);
    expect(created.body.flowLabel).toBe('Test Flow');
    // Empty node list → plain Update {label}; AI-supplied titles still win when present.
    expect(created.body.title).toBe('Update Test Flow');

    // Bump live rev so the pending proposal becomes stale on list.
    const staleAdapter = {
      kind: 'red' as const,
      getFlows: () =>
        Promise.resolve({
          rev: 'rev-newer',
          flows: [{ id: 'tab-1', type: 'tab', label: 'Test Flow' }],
        }),
      getFlow: () =>
        Promise.resolve({
          rev: 'rev-newer',
          flow: { id: 'tab-1', type: 'tab', label: 'Test Flow', nodes: [] },
        }),
      updateFlow: () => Promise.resolve({ flowId: 'tab-1', rev: 'rev-next' }),
    };
    // Re-register is heavy; instead create a second app sharing the same store via userDir.
    const { app: app2 } = createApp({
      userDir,
      authenticate: asUser('*', 'admin'),
      adapter: staleAdapter,
    });
    const listed = await request(app2).get('/mcp/api/v1/proposals');
    expect(listed.status).toBe(200);
    expect(listed.body.proposals).toHaveLength(1);
    expect(listed.body.proposals[0].baseRevStale).toBe(true);
    expect(listed.body.proposals[0].flowLabel).toBe('Test Flow');
    expect(listed.body.proposals[0].flowLabel).not.toBe('tab-1');
  });

  it('read admin and access links can list all proposals; mine flags ownership', async () => {
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('read', 'guest'),
    });
    const a = linkStore.create({ kind: 'rest', label: 'a' });
    const b = linkStore.create({ kind: 'rest', label: 'b' });

    await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${a.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', flow: { id: 'tab-1', type: 'tab', nodes: [] } },
      });
    await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${b.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', flow: { id: 'tab-1', type: 'tab', nodes: [] } },
      });

    const asLink = await request(app)
      .get('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${a.token}`);
    expect(asLink.status).toBe(200);
    expect(asLink.body.proposals).toHaveLength(2);
    const mines = Object.fromEntries(
      asLink.body.proposals.map((p: { createdBy: { linkId: string }; mine: boolean }) => [
        p.createdBy.linkId,
        p.mine,
      ])
    );
    expect(mines[a.id]).toBe(true);
    expect(mines[b.id]).toBe(false);

    const onlyMine = await request(app)
      .get('/mcp/api/v1/proposals?mine=true')
      .set('Authorization', `Bearer ${a.token}`);
    expect(onlyMine.body.proposals).toHaveLength(1);
    expect(onlyMine.body.proposals[0].createdBy.linkId).toBe(a.id);
    expect(onlyMine.body.proposals[0].mine).toBe(true);

    const asAdmin = await request(app).get('/mcp/api/v1/proposals');
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.proposals).toHaveLength(2);
  });

  it('read user cannot approve or reject', async () => {
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('read', 'guest'),
    });
    const link = linkStore.create({ kind: 'rest' });
    const created = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', flow: { id: 'tab-1', type: 'tab', nodes: [] } },
      });
    expect(created.status).toBe(201);

    const approve = await request(app).post(`/mcp/api/v1/proposals/${created.body.id}/approve`);
    expect(approve.status).toBe(403);
    const reject = await request(app)
      .post(`/mcp/api/v1/proposals/${created.body.id}/reject`)
      .send({ reason: 'no' });
    expect(reject.status).toBe(403);
  });

  it('reject does not mutate flows via adapter', async () => {
    const updateFlow = vi.fn();
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('*', 'admin'),
      adapter: {
        kind: 'red',
        getFlows: () => Promise.resolve({ rev: 'r', flows: [] }),
        getFlow: () => Promise.resolve({ rev: 'r', flow: { id: 'tab-1', nodes: [] } }),
        updateFlow,
      },
    });
    const link = linkStore.create({ kind: 'rest' });
    const created = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'r',
        payload: { flowId: 'tab-1', flow: { id: 'tab-1', type: 'tab', nodes: [] } },
      });
    expect(created.status).toBe(201);

    const rejected = await request(app)
      .post(`/mcp/api/v1/proposals/${created.body.id}/reject`)
      .send({ reason: 'not now' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect(updateFlow).not.toHaveBeenCalled();
  });

  it('approve with rev conflict returns rejected proposal', async () => {
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('*', 'admin'),
      adapter: {
        kind: 'red',
        getFlows: () => Promise.resolve({ rev: 'r', flows: [] }),
        getFlow: () => Promise.resolve({ rev: 'r', flow: { id: 'tab-1', nodes: [] } }),
        updateFlow: () => Promise.reject(new FlowRevisionConflictError('r', 'new')),
      },
    });
    const link = linkStore.create({ kind: 'rest' });
    const created = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'r',
        payload: { flowId: 'tab-1', flow: { id: 'tab-1', type: 'tab', nodes: [] } },
      });
    expect(created.status).toBe(201);

    const result = await request(app).post(`/mcp/api/v1/proposals/${created.body.id}/approve`);
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('rejected');
    expect(result.body.reason).toMatch(/resubmit/i);
  });

  it('GET /proposals/:id/diff compares against the stored base snapshot', async () => {
    const baseNodes = [
      { id: 'n1', type: 'inject', name: 'tick' },
      { id: 'n2', type: 'function', name: 'fn', func: 'return msg;' },
    ];
    let liveNodes = [...baseNodes];
    let liveRev = 'rev-1';
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('read', 'guest'),
      adapter: {
        kind: 'red',
        getFlows: () => Promise.resolve({ rev: liveRev, flows: [] }),
        getFlow: () =>
          Promise.resolve({
            rev: liveRev,
            flow: {
              id: 'tab-1',
              type: 'tab',
              label: 'Main',
              nodes: liveNodes.map(n => ({ ...n })),
            },
          }),
        updateFlow: () => Promise.resolve({ flowId: 'tab-1', rev: 'rev-2' }),
      },
    });
    const link = linkStore.create({ kind: 'rest', label: 'diff-agent' });
    const created = await request(app)
      .post('/mcp/api/v1/proposals?include=payload,baseFlow')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: {
          flowId: 'tab-1',
          flow: {
            id: 'tab-1',
            type: 'tab',
            label: 'Main',
            nodes: [
              {
                id: 'n2',
                type: 'function',
                name: 'fn',
                func: 'msg.x = 1;\nreturn msg;',
              },
              { id: 'n3', type: 'debug', name: 'out' },
            ],
          },
        },
      });
    expect(created.status).toBe(201);
    expect(created.body.baseFlow?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'n1' })])
    );

    // Another approval added html20k to the live flow — must not pollute this diff.
    liveRev = 'rev-2';
    liveNodes = [
      ...baseNodes,
      { id: 'html20k', type: 'template', name: 'html20k', template: '<p>big</p>' },
    ];

    const asAdmin = await request(app).get(`/mcp/api/v1/proposals/${created.body.id}/diff`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body).toMatchObject({
      proposalId: created.body.id,
      flowId: 'tab-1',
      expectedRev: 'rev-1',
      currentRev: 'rev-2',
      baseRevStale: true,
      compareAgainst: 'base',
      summary: { added: 1, removed: 1, modified: 1 },
    });
    expect(asAdmin.body.removed).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'html20k' })])
    );
    expect(asAdmin.body.added).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'n3',
          type: 'debug',
          properties: expect.arrayContaining([
            expect.objectContaining({ key: 'name', kind: 'scalar', value: 'out' }),
          ]),
        }),
      ])
    );
    expect(asAdmin.body.removed).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'n1', type: 'inject' })])
    );
    const funcChange = asAdmin.body.modified
      .find((m: { id: string }) => m.id === 'n2')
      ?.changes.find((c: { key: string }) => c.key === 'func');
    expect(funcChange?.kind).toBe('text');
    expect(funcChange?.lines?.some((l: { op: string }) => l.op === 'add')).toBe(true);
    expect(asAdmin.body.vsCurrent?.removed).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'html20k' })])
    );

    const asLink = await request(app)
      .get(`/mcp/api/v1/proposals/${created.body.id}/diff`)
      .set('Authorization', `Bearer ${link.token}`);
    expect(asLink.status).toBe(200);
    expect(asLink.body.proposalId).toBe(created.body.id);

    // Any access link can read diffs (visibility decision); ownership is mine on get/list.
    const other = linkStore.create({ kind: 'rest', label: 'other' });
    const otherDiff = await request(app)
      .get(`/mcp/api/v1/proposals/${created.body.id}/diff`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(otherDiff.status).toBe(200);
    expect(otherDiff.body.proposalId).toBe(created.body.id);
  });

  it('GET /proposals/:id/diff sets baseRevStale only while pending', async () => {
    let liveRev = 'rev-1';
    const adapter: FlowAdapter = {
      kind: 'red',
      getFlows: () => Promise.resolve({ rev: liveRev, flows: [] }),
      getFlow: () =>
        Promise.resolve({
          rev: liveRev,
          flow: { id: 'tab-1', type: 'tab', nodes: [] },
        }),
      updateFlow: () => Promise.resolve({ flowId: 'tab-1', rev: 'rev-2' }),
    };
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('*', 'admin'),
      adapter,
    });
    const link = linkStore.create({ kind: 'rest' });
    const created = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', flow: { id: 'tab-1', type: 'tab', nodes: [] } },
      });
    expect(created.status).toBe(201);

    liveRev = 'rev-live';
    const pendingDiff = await request(app).get(`/mcp/api/v1/proposals/${created.body.id}/diff`);
    expect(pendingDiff.status).toBe(200);
    expect(pendingDiff.body.baseRevStale).toBe(true);
    expect(pendingDiff.body.currentRev).toBe('rev-live');
    expect(pendingDiff.body.expectedRev).toBe('rev-1');
    expect(pendingDiff.body.compareAgainst).toBe('base');

    await request(app).post(`/mcp/api/v1/proposals/${created.body.id}/reject`).send({
      reason: 'not needed',
    });
    const rejectedDiff = await request(app).get(`/mcp/api/v1/proposals/${created.body.id}/diff`);
    expect(rejectedDiff.status).toBe(200);
    expect(rejectedDiff.body.baseRevStale).toBe(false);
    expect(rejectedDiff.body.compareAgainst).toBe('base');
  });

  it('rejects stale expectedRev at submit time with 409', async () => {
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('*', 'admin'),
    });
    const link = linkStore.create({ kind: 'rest' });
    const created = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'stale123',
        payload: { flowId: 'tab-1', flow: { id: 'tab-1', type: 'tab', nodes: [] } },
      });
    expect(created.status).toBe(409);
    expect(created.body).toMatchObject({
      code: 'version_mismatch',
      expectedRev: 'stale123',
      currentRev: 'rev-1',
    });
  });

  it('rejects proposal and flow routes when AI features are disabled', async () => {
    const app = express();
    app.use(express.json());
    const linkStore = new AccessLinkStore({ maxActiveLinks: 10 });
    const RED: NodeRedPluginAPI = {
      settings: {
        userDir,
        httpAdminRoot: '/',
        // no adminAuth, no allowWithoutAdminAuth → AI off
      },
      httpAdmin: app,
      auth: {
        needsPermission() {
          return (_req: Request, _res: Response, next: NextFunction) => next();
        },
      },
      plugins: {
        registerPlugin() {
          // unused in this test
        },
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    registerRoutes(RED, {
      linkStore,
      flowAdapter: {
        kind: 'red',
        getFlows: () => Promise.resolve({ rev: 'r', flows: [] }),
        getFlow: () => Promise.resolve({ rev: 'r', flow: { id: 'tab-1', nodes: [] } }),
        updateFlow: () => Promise.resolve({ flowId: 'tab-1', rev: 'r2' }),
      },
    });

    const flows = await request(app).get('/mcp/api/v1/flows');
    expect(flows.status).toBe(403);
    const proposals = await request(app).get('/mcp/api/v1/proposals');
    expect(proposals.status).toBe(403);
    const logs = await request(app).get('/mcp/api/v1/logs');
    expect(logs.status).toBe(403);
  });
});
