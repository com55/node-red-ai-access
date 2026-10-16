/**
 * Stale auto-close (expired/superseded), conflict trim, GET withdraw confirm=1.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import {
  expireStalePendingProposals,
  findConflictingProposals,
} from '../../src/plugin/proposal-conflicts.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter } from '../../src/runtime/types.js';
import { ensureAiAccessDirs, resolveAiAccessPaths } from '../../src/storage/paths.js';
import { ProposalStore } from '../../src/storage/proposals.js';

interface MockUser {
  username: string;
  permissions: string | string[];
}

function asUser(permissions: string | string[], username = 'admin') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    (req as Request & { user?: MockUser }).user = { username, permissions };
    next();
  };
}

function createApp(
  userDir: string,
  options: {
    rev?: string;
    authenticate?: (req: Request, _res: Response, next: NextFunction) => void;
  } = {}
): { app: Express; linkStore: AccessLinkStore; adapter: FlowAdapter } {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 20 });
  const rev = options.rev ?? 'rev-1';
  const authenticate =
    options.authenticate ?? ((_req: Request, _res: Response, next: NextFunction) => next());

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir,
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
        // unused
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  const adapter: FlowAdapter = {
    kind: 'red',
    getFlows: () =>
      Promise.resolve({
        rev,
        flows: [
          { id: 'tab-1', type: 'tab', label: 'Main' },
          { id: 'n1', type: 'inject', z: 'tab-1' },
          { id: 'n2', type: 'template', z: 'tab-1' },
        ],
      }),
    getFlow: (id: string) =>
      Promise.resolve({
        rev,
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
  return { app, linkStore, adapter };
}

describe('stale close, conflict trim, GET withdraw confirm', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-stale-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('findConflictingProposals keeps same-rev and overlaps; skips other older-rev peers', () => {
    const paths = resolveAiAccessPaths(userDir);
    ensureAiAccessDirs(paths);
    const store = new ProposalStore(paths, {
      randomId: (() => {
        let n = 0;
        return () => `id${++n}`;
      })(),
    });

    const base = {
      type: 'replace_flow' as const,
      expectedRev: 'rev-1',
      baseFlow: {
        id: 'tab-1',
        type: 'tab',
        label: 'Main',
        nodes: [
          { id: 'n1', type: 'inject', name: 'a' },
          { id: 'n2', type: 'template', name: 'b' },
        ],
      },
      createdBy: { kind: 'access-link' as const, linkId: 'link-1', label: 'a' },
    };

    const self = store.create({
      ...base,
      title: 'self',
      payload: {
        flowId: 'tab-1',
        flow: {
          id: 'tab-1',
          type: 'tab',
          nodes: [
            { id: 'n1', type: 'inject', name: 'a2' },
            { id: 'n2', type: 'template', name: 'b' },
          ],
        },
      },
    });

    // Same rev, no overlap (touches only n2) — still listed.
    const sameRevPeer = store.create({
      ...base,
      title: 'same-rev',
      createdBy: { kind: 'access-link', linkId: 'link-2', label: 'b' },
      payload: {
        flowId: 'tab-1',
        flow: {
          id: 'tab-1',
          type: 'tab',
          nodes: [
            { id: 'n1', type: 'inject', name: 'a' },
            { id: 'n2', type: 'template', name: 'b2' },
          ],
        },
      },
    });

    // Different rev, overlapping n1 — listed with overlap.
    const overlapOld = store.create({
      ...base,
      expectedRev: 'rev-0',
      title: 'overlap-old',
      createdBy: { kind: 'access-link', linkId: 'link-3', label: 'c' },
      payload: {
        flowId: 'tab-1',
        flow: {
          id: 'tab-1',
          type: 'tab',
          nodes: [
            { id: 'n1', type: 'inject', name: 'conflict' },
            { id: 'n2', type: 'template', name: 'b' },
          ],
        },
      },
    });

    // Different rev, no overlap — not a conflict.
    const staleOther = store.create({
      ...base,
      expectedRev: 'rev-0',
      title: 'stale-other',
      createdBy: { kind: 'access-link', linkId: 'link-4', label: 'd' },
      payload: {
        flowId: 'tab-1',
        flow: {
          id: 'tab-1',
          type: 'tab',
          nodes: [
            { id: 'n1', type: 'inject', name: 'a' },
            { id: 'n2', type: 'template', name: 'only-n2' },
          ],
        },
      },
    });

    const result = findConflictingProposals(store, self, 'link-1');
    const ids = result.conflictingProposals.map(c => c.id);
    expect(ids).toContain(sameRevPeer.id);
    expect(ids).toContain(overlapOld.id);
    expect(ids).not.toContain(staleOther.id);
    expect(result).not.toHaveProperty('staleOnOlderRev');
    const overlapRef = result.conflictingProposals.find(c => c.id === overlapOld.id);
    expect(overlapRef?.overlappingNodeIds).toEqual(expect.arrayContaining(['n1']));
  });

  it('expires pending proposals when liveRev moves', () => {
    const paths = resolveAiAccessPaths(userDir);
    ensureAiAccessDirs(paths);
    const store = new ProposalStore(paths);
    const created = store.create({
      type: 'replace_flow',
      expectedRev: 'rev-1',
      title: 'old',
      payload: {
        flowId: 'tab-1',
        flow: { id: 'tab-1', type: 'tab', nodes: [{ id: 'n1', type: 'inject', name: 'x' }] },
      },
      baseFlow: {
        id: 'tab-1',
        type: 'tab',
        nodes: [{ id: 'n1', type: 'inject', name: 'y' }],
      },
      createdBy: { kind: 'access-link', linkId: 'l1' },
    });
    expect(expireStalePendingProposals(store, 'rev-2')).toBe(1);
    expect(store.get(created.id).status).toBe('expired');
    expect(store.get(created.id).reason).toMatch(/expired/i);
  });

  it('approving one proposal supersedes other pending on the same flow', async () => {
    const { app, linkStore } = createApp(userDir, { authenticate: asUser('*') });
    const link = linkStore.create({ label: 'bot', kind: 'rest' });
    const auth = { Authorization: `Bearer ${link.token}` };

    const a = await request(app)
      .post('/mcp/api/v1/proposals')
      .set(auth)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'first',
        payload: { flowId: 'tab-1', nodes: [{ op: 'set', id: 'n1', set: { name: 'A' } }] },
      });
    const b = await request(app)
      .post('/mcp/api/v1/proposals')
      .set(auth)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'second',
        payload: { flowId: 'tab-1', nodes: [{ op: 'set', id: 'n2', set: { name: 'B' } }] },
      });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const approved = await request(app).post(`/mcp/api/v1/proposals/${a.body.id}/approve`).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    const other = await request(app).get(`/mcp/api/v1/proposals/${b.body.id}`).set(auth);
    expect(other.status).toBe(200);
    expect(other.body.status).toBe('superseded');
    expect(other.body.reason).toMatch(/Superseded/i);
  });

  it('list omits conflictingProposals; get/submit may include them', async () => {
    const { app, linkStore } = createApp(userDir);
    const a = linkStore.create({ label: 'a', kind: 'rest' });
    const b = linkStore.create({ label: 'b', kind: 'rest' });

    await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${a.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'from-a',
        payload: { flowId: 'tab-1', nodes: [{ op: 'set', id: 'n1', set: { name: 'A' } }] },
      });

    const fromB = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${b.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'from-b',
        payload: { flowId: 'tab-1', nodes: [{ op: 'set', id: 'n1', set: { name: 'B' } }] },
      });
    expect(fromB.status).toBe(201);
    expect(fromB.body.conflictingProposals?.length).toBeGreaterThan(0);

    const list = await request(app)
      .get('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${b.token}`);
    expect(list.status).toBe(200);
    for (const p of list.body.proposals) {
      expect(p.conflictingProposals).toBeUndefined();
    }

    const got = await request(app)
      .get(`/mcp/api/v1/proposals/${fromB.body.id}`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(got.body.conflictingProposals?.length).toBeGreaterThan(0);
  });

  it('GET withdraw requires confirm=1', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ label: 'g', kind: 'get_link' });
    const created = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&node=n1&set.name=G&title=gw`
    );
    expect(created.status).toBe(201);
    const id = created.body.proposal.id as string;

    const blocked = await request(app).get(
      `/mcp/a/${link.token}/proposals/${id}/withdraw?reason=no`
    );
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('confirm_required');

    const ok = await request(app).get(
      `/mcp/a/${link.token}/proposals/${id}/withdraw?confirm=1&reason=yes`
    );
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('withdrawn');
  });
});
