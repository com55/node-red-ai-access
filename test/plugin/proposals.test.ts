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
    const createdLink = linkStore.create({ label: 'deploy-type' });
    const created = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${createdLink.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', flow: { nodes: [] } },
      });

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

    const link = linkStore.create({ label: 'agent' });

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
          flow: { label: 'Main', nodes: [{ id: 'n1', type: 'inject' }] },
        },
      });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');

    const approved = await request(app).post(`/mcp/api/v1/proposals/${created.body.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(updateFlow).toHaveBeenCalledOnce();

    const logs = await request(app).get('/mcp/api/v1/logs');
    expect(logs.status).toBe(200);
    expect(logs.body.logs.some((e: { action: string }) => e.action === 'proposal.approved')).toBe(
      true
    );
  });

  it('read admin can list all proposals; access link only sees its own', async () => {
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('read', 'guest'),
    });
    const a = linkStore.create({ label: 'a' });
    const b = linkStore.create({ label: 'b' });

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
    expect(asLink.body.proposals).toHaveLength(1);
    expect(asLink.body.proposals[0].createdBy.linkId).toBe(a.id);

    const asAdmin = await request(app).get('/mcp/api/v1/proposals');
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.proposals).toHaveLength(2);
  });

  it('read user cannot approve or reject', async () => {
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('read', 'guest'),
    });
    const link = linkStore.create();
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
    const link = linkStore.create();
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
    const link = linkStore.create();
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

  it('GET /proposals/:id/diff compares against the live flow', async () => {
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('read', 'guest'),
      adapter: {
        kind: 'red',
        getFlows: () => Promise.resolve({ rev: 'rev-1', flows: [] }),
        getFlow: () =>
          Promise.resolve({
            rev: 'rev-1',
            flow: {
              id: 'tab-1',
              type: 'tab',
              label: 'Main',
              nodes: [
                { id: 'n1', type: 'inject', name: 'tick' },
                { id: 'n2', type: 'function', name: 'fn', func: 'return msg;' },
              ],
            },
          }),
        updateFlow: () => Promise.resolve({ flowId: 'tab-1', rev: 'rev-2' }),
      },
    });
    const link = linkStore.create({ label: 'diff-agent' });
    const created = await request(app)
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

    const asAdmin = await request(app).get(`/mcp/api/v1/proposals/${created.body.id}/diff`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body).toMatchObject({
      proposalId: created.body.id,
      flowId: 'tab-1',
      expectedRev: 'rev-1',
      currentRev: 'rev-1',
      baseRevStale: false,
      summary: { added: 1, removed: 1, modified: 1 },
    });
    expect(asAdmin.body.added).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'n3', type: 'debug' })])
    );
    expect(asAdmin.body.removed).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'n1', type: 'inject' })])
    );
    const funcChange = asAdmin.body.modified
      .find((m: { id: string }) => m.id === 'n2')
      ?.changes.find((c: { key: string }) => c.key === 'func');
    expect(funcChange?.kind).toBe('text');
    expect(funcChange?.lines?.some((l: { op: string }) => l.op === 'add')).toBe(true);

    const asLink = await request(app)
      .get(`/mcp/api/v1/proposals/${created.body.id}/diff`)
      .set('Authorization', `Bearer ${link.token}`);
    expect(asLink.status).toBe(200);
    expect(asLink.body.proposalId).toBe(created.body.id);

    const other = linkStore.create({ label: 'other' });
    const denied = await request(app)
      .get(`/mcp/api/v1/proposals/${created.body.id}/diff`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(denied.status).toBe(404);
  });

  it('GET /proposals/:id/diff sets baseRevStale when live rev moved', async () => {
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
    const link = linkStore.create();
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
    const diff = await request(app).get(`/mcp/api/v1/proposals/${created.body.id}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.body.baseRevStale).toBe(true);
    expect(diff.body.currentRev).toBe('rev-live');
    expect(diff.body.expectedRev).toBe('rev-1');
  });

  it('rejects stale expectedRev at submit time with 409', async () => {
    const { app, linkStore } = createApp({
      userDir,
      authenticate: asUser('*', 'admin'),
    });
    const link = linkStore.create();
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
