/**
 * Access-link admin routes and Bearer middleware tests.
 */

import { createHash } from 'node:crypto';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import {
  ACCESS_LINK_BEARER_REQUIRED_CODE,
  ACCESS_LINK_BEARER_REQUIRED_MESSAGE,
  ACCESS_LINK_INVALID_MESSAGE,
  ACCESS_LINK_MISSING_CODE,
  requireAccessLink,
} from '../../src/plugin/access-link-auth.js';
import registerAiAccessPlugin, { registerRoutes } from '../../src/plugin/index.js';
import { createAiAccessRateLimiter } from '../../src/plugin/rate-limit.js';
import type { AiAccessSettings, NodeRedPluginAPI } from '../../src/plugin/types.js';

interface MockUser {
  username: string;
  permissions: string | string[];
}

function createMockRed(options: {
  adminAuth?: unknown;
  aiAccess?: AiAccessSettings;
  userDir?: string;
  authenticate?: (req: Request, _res: Response, next: NextFunction) => void;
}): { app: Express; RED: NodeRedPluginAPI } {
  const app = express();
  app.use(express.json());

  const authenticate =
    options.authenticate ??
    ((_req: Request, _res: Response, next: NextFunction) => {
      next();
    });

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir: options.userDir ?? '/tmp/node-red-user',
      httpAdminRoot: '/',
      ...(options.adminAuth !== undefined ? { adminAuth: options.adminAuth } : {}),
      ...(options.aiAccess !== undefined ? { aiAccess: options.aiAccess } : {}),
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
      registerPlugin(_id: string, definition?: Record<string, unknown>) {
        const onadd = definition?.onadd;
        if (typeof onadd === 'function') {
          (onadd as () => void)();
        }
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  registerAiAccessPlugin(RED);
  return { app, RED };
}

function asStarUser(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { user?: MockUser }).user = { username: 'admin', permissions: '*' };
  next();
}

function asReadUser(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { user?: MockUser }).user = { username: 'guest', permissions: 'read' };
  next();
}

describe('GET/POST/DELETE /mcp/api/v1/links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets a * user create, list, and revoke links; token only on create', async () => {
    const { app } = createMockRed({
      adminAuth: { type: 'credentials' },
      authenticate: asStarUser,
    });

    const created = await request(app)
      .post('/mcp/api/v1/links')
      .send({ label: 'agent', ttlSeconds: 120 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: expect.any(String),
      kind: 'get_link',
      token: expect.stringMatching(/^aia_/),
      label: 'agent',
      url: expect.stringMatching(/\/mcp\/a\/aia_/),
    });

    const listed = await request(app).get('/mcp/api/v1/links');
    expect(listed.status).toBe(200);
    expect(listed.body.links).toHaveLength(1);
    // Raw `token` field stays create-only; active links expose `url` for re-copy.
    expect(listed.body.links[0]).not.toHaveProperty('token');
    expect(listed.body.links[0].url).toMatch(new RegExp(`/mcp/a/${created.body.token}$`));

    const revoked = await request(app).delete(`/mcp/api/v1/links/${created.body.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ revoked: true });

    const after = await request(app).get('/mcp/api/v1/links');
    expect(after.body.links).toHaveLength(0);

    const logs = await request(app).get('/mcp/api/v1/logs?limit=20');
    expect(logs.status).toBe(200);
    expect(logs.body.logs.some((e: { action: string }) => e.action === 'link.created')).toBe(true);
    expect(logs.body.logs.some((e: { action: string }) => e.action === 'link.revoked')).toBe(true);

    // Real stored event shape (post-sanitize): label + expiry must survive for the audit UI.
    const createdLog = logs.body.logs.find(
      (e: { action: string }) => e.action === 'link.created'
    ) as {
      details?: {
        linkId?: string;
        label?: string;
        expiresAt?: string;
        createdAt?: string;
        ttlSeconds?: number;
      };
    };
    expect(createdLog?.details).toMatchObject({
      linkId: created.body.id,
      label: 'agent',
      expiresAt: created.body.expiresAt,
      createdAt: created.body.createdAt,
      ttlSeconds: 120,
      kind: 'get_link',
    });
    const revokedLog = logs.body.logs.find(
      (e: { action: string }) => e.action === 'link.revoked'
    ) as { details?: { linkId?: string; label?: string; expiresAt?: string } };
    expect(revokedLog?.details).toMatchObject({
      linkId: created.body.id,
      label: 'agent',
      expiresAt: created.body.expiresAt,
    });
  });

  it('persists link label/expiry in audit even for a smoke-test style create', async () => {
    const { app } = createMockRed({
      adminAuth: { type: 'credentials' },
      authenticate: asStarUser,
    });

    const created = await request(app)
      .post('/mcp/api/v1/links')
      .send({ label: 'smoke-test-d546bec', ttlSeconds: 86_400 });
    expect(created.status).toBe(201);

    const logs = await request(app).get('/mcp/api/v1/logs?limit=5');
    expect(logs.status).toBe(200);
    const entry = logs.body.logs.find((e: { action: string }) => e.action === 'link.created');
    expect(entry).toBeTruthy();
    // Client reads details.label / details.expiresAt / details.ttlSeconds (not nested).
    expect(entry.details.label).toBe('smoke-test-d546bec');
    expect(entry.details.expiresAt).toBe(created.body.expiresAt);
    expect(entry.details.linkId).toBe(created.body.id);
    expect(entry.details.ttlSeconds).toBe(86_400);
    expect(typeof entry.details.expiresAt).toBe('string');
  });

  it('returns 403 when a read user tries to manage links', async () => {
    const { app } = createMockRed({
      adminAuth: { type: 'credentials' },
      authenticate: asReadUser,
    });

    const list = await request(app).get('/mcp/api/v1/links');
    expect(list.status).toBe(403);

    const create = await request(app).post('/mcp/api/v1/links').send({});
    expect(create.status).toBe(403);

    const revoke = await request(app).delete('/mcp/api/v1/links/anything');
    expect(revoke.status).toBe(403);
  });

  it('returns 409 when creating more than 10 active links', async () => {
    const { app } = createMockRed({
      adminAuth: { type: 'credentials' },
      authenticate: asStarUser,
    });

    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post('/mcp/api/v1/links')
        .send({ label: `l${i}` });
      expect(res.status).toBe(201);
    }

    const overflow = await request(app).post('/mcp/api/v1/links').send({ label: 'overflow' });
    expect(overflow.status).toBe(409);
    expect(overflow.body.code).toBe('access_link_limit');
  });

  it('rejects link routes when AI features are disabled', async () => {
    const { app } = createMockRed({});

    const list = await request(app).get('/mcp/api/v1/links');
    expect(list.status).toBe(403);
    expect(list.body.error).toMatch(/disabled/i);
  });

  it('creates links with each kind; defaults to get_link; omits url for rest/mcp', async () => {
    const { app } = createMockRed({
      adminAuth: { type: 'credentials' },
      authenticate: asStarUser,
    });

    const def = await request(app).post('/mcp/api/v1/links').send({ label: 'default' });
    expect(def.status).toBe(201);
    expect(def.body.kind).toBe('get_link');
    expect(def.body.url).toMatch(/\/mcp\/a\//);

    for (const kind of ['get_link', 'rest', 'mcp'] as const) {
      const res = await request(app).post('/mcp/api/v1/links').send({ label: kind, kind });
      expect(res.status).toBe(201);
      expect(res.body.kind).toBe(kind);
      expect(res.body.token).toMatch(/^aia_/);
      if (kind === 'get_link') {
        expect(res.body.url).toMatch(/\/mcp\/a\//);
      } else {
        expect(res.body.url).toBeUndefined();
      }
    }

    const listed = await request(app).get('/mcp/api/v1/links');
    expect(listed.status).toBe(200);
    const byKind = Object.fromEntries(
      listed.body.links.map((l: { kind: string; url?: string; label?: string }) => [l.label, l])
    );
    expect(byKind.rest.url).toBeUndefined();
    expect(byKind.mcp.url).toBeUndefined();
    expect(byKind.get_link.url).toMatch(/\/mcp\/a\//);

    const logs = await request(app).get('/mcp/api/v1/logs?limit=50');
    const restCreated = logs.body.logs.find(
      (e: { action: string; details?: { label?: string; kind?: string } }) =>
        e.action === 'link.created' && e.details?.label === 'rest'
    );
    expect(restCreated?.details?.kind).toBe('rest');
  });

  it('rejects invalid kind with 400 invalid_link_kind', async () => {
    const { app } = createMockRed({
      adminAuth: { type: 'credentials' },
      authenticate: asStarUser,
    });

    const res = await request(app).post('/mcp/api/v1/links').send({ kind: 'websocket' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_link_kind');
  });
});

describe('requireAccessLink middleware', () => {
  function probeApp(RED: NodeRedPluginAPI, store: AccessLinkStore) {
    const app = express();
    const limiter = createAiAccessRateLimiter();
    app.get('/probe', limiter, requireAccessLink(RED, store, 'get_link'), (req, res) => {
      res.json({ ok: true, id: (req as Request & { accessLink?: { id: string } }).accessLink?.id });
    });
    return app;
  }

  it('accepts a valid Bearer token and rejects unknown/expired/revoked/restarted', async () => {
    let now = 1_000_000;
    const store = new AccessLinkStore({
      now: () => now,
      randomToken: () => 'aia_middleware-token',
    });
    const created = store.create({ ttlSeconds: 30 });

    const RED = {
      settings: { userDir: '/tmp', adminAuth: { type: 'credentials' } },
    } as NodeRedPluginAPI;

    const app = probeApp(RED, store);

    const ok = await request(app).get('/probe').set('Authorization', `Bearer ${created.token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(created.id);

    const unknown = await request(app).get('/probe').set('Authorization', 'Bearer aia_nope');
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe(ACCESS_LINK_INVALID_MESSAGE);

    now += 60_000;
    const expired = await request(app)
      .get('/probe')
      .set('Authorization', `Bearer ${created.token}`);
    expect(expired.status).toBe(401);
    expect(expired.body.error).toMatch(/Ask the user for a new access link/);

    now = 1_000_000;
    const store2 = new AccessLinkStore({
      now: () => now,
      randomToken: () => 'aia_to-revoke',
    });
    const second = store2.create({ ttlSeconds: 100 });
    store2.revoke(second.id);
    const app2 = probeApp(RED, store2);
    const revoked = await request(app2)
      .get('/probe')
      .set('Authorization', `Bearer ${second.token}`);
    expect(revoked.status).toBe(401);

    const store3 = new AccessLinkStore({ randomToken: () => 'aia_restarted' });
    const third = store3.create();
    store3.clear();
    const app3 = probeApp(RED, store3);
    const restarted = await request(app3)
      .get('/probe')
      .set('Authorization', `Bearer ${third.token}`);
    expect(restarted.status).toBe(401);
    expect(restarted.body.error).toBe(ACCESS_LINK_INVALID_MESSAGE);
  });

  it('rejects every request when AI features are disabled', async () => {
    const store = new AccessLinkStore();
    const created = store.create();
    const RED = {
      settings: { userDir: '/tmp' },
    } as NodeRedPluginAPI;

    const app = probeApp(RED, store);

    const res = await request(app).get('/probe').set('Authorization', `Bearer ${created.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it('rejects Authorization: Basic with bearer_scheme_required', async () => {
    const store = new AccessLinkStore();
    const RED = {
      settings: { userDir: '/tmp', adminAuth: { type: 'credentials' } },
    } as NodeRedPluginAPI;
    const app = probeApp(RED, store);

    const res = await request(app).get('/probe').set('Authorization', 'Basic YWRtaW46cGFzc3dvcmQ=');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: ACCESS_LINK_BEARER_REQUIRED_MESSAGE,
      code: ACCESS_LINK_BEARER_REQUIRED_CODE,
    });
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    expect(res.body.error).toMatch(/Bearer/i);
    expect(res.body.error).not.toMatch(/missing/i);
  });

  it('rejects empty Authorization as access_link_missing', async () => {
    const store = new AccessLinkStore();
    const RED = {
      settings: { userDir: '/tmp', adminAuth: { type: 'credentials' } },
    } as NodeRedPluginAPI;
    const app = probeApp(RED, store);

    const res = await request(app).get('/probe');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ACCESS_LINK_MISSING_CODE);
  });

  it('rejects wrong kind with wrong_token_kind when expectedKind is set', async () => {
    const store = new AccessLinkStore();
    const getLink = store.create({ kind: 'get_link' });
    const rest = store.create({ kind: 'rest' });
    const RED = {
      settings: { userDir: '/tmp', adminAuth: { type: 'credentials' } },
    } as NodeRedPluginAPI;

    const app = express();
    const limiter = createAiAccessRateLimiter();
    app.get('/rest-probe', limiter, requireAccessLink(RED, store, 'rest'), (_req, res) => {
      res.json({ ok: true });
    });

    const wrong = await request(app)
      .get('/rest-probe')
      .set('Authorization', `Bearer ${getLink.token}`);
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({
      code: 'wrong_token_kind',
      expectedKind: 'rest',
      actualKind: 'get_link',
    });
    expect(typeof wrong.body.hint).toBe('string');

    const ok = await request(app).get('/rest-probe').set('Authorization', `Bearer ${rest.token}`);
    expect(ok.status).toBe(200);
  });
});

describe('token kind surface gates', () => {
  it('rejects get_link on REST/MCP, rest on GET-link/MCP, mcp on REST/GET-link', async () => {
    const { app } = createMockRed({
      adminAuth: { type: 'credentials' },
      authenticate: asStarUser,
      aiAccess: { allowWithoutAdminAuth: true },
    });

    const mint = async (kind: 'get_link' | 'rest' | 'mcp') => {
      const res = await request(app).post('/mcp/api/v1/links').send({ kind, label: kind });
      expect(res.status).toBe(201);
      return res.body.token as string;
    };

    const getLink = await mint('get_link');
    const rest = await mint('rest');
    const mcp = await mint('mcp');

    const expectWrong = async (
      res: { status: number; body: Record<string, unknown> },
      expectedKind: string,
      actualKind: string
    ) => {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'wrong_token_kind',
        expectedKind,
        actualKind,
      });
      expect(typeof res.body.hint).toBe('string');
    };

    // get_link rejected on REST and MCP
    await expectWrong(
      await request(app).get('/mcp/api/v1/flows').set('Authorization', `Bearer ${getLink}`),
      'rest',
      'get_link'
    );
    await expectWrong(
      await request(app)
        .post('/mcp/api/v1/proposals')
        .set('Authorization', `Bearer ${getLink}`)
        .send({
          type: 'replace_flow',
          expectedRev: 'r',
          payload: { flowId: 't', flow: { id: 't', type: 'tab', nodes: [] } },
        }),
      'rest',
      'get_link'
    );
    await expectWrong(
      await request(app)
        .post('/mcp/rpc')
        .set('Authorization', `Bearer ${getLink}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      'mcp',
      'get_link'
    );

    // rest rejected on GET-link and MCP
    await expectWrong(await request(app).get(`/mcp/a/${rest}/status`), 'get_link', 'rest');
    await expectWrong(
      await request(app)
        .post('/mcp/rpc')
        .set('Authorization', `Bearer ${rest}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      'mcp',
      'rest'
    );

    // mcp rejected on REST and GET-link
    await expectWrong(
      await request(app).get('/mcp/api/v1/flows').set('Authorization', `Bearer ${mcp}`),
      'rest',
      'mcp'
    );
    await expectWrong(await request(app).get(`/mcp/a/${mcp}/status`), 'get_link', 'mcp');
  });

  it('legacy record without kind behaves as get_link on GET-link path', async () => {
    const app = express();
    app.use(express.json());
    const token = 'aia_legacy_surface_token_value_xx';
    const linkStore = new AccessLinkStore();
    linkStore.upsertRecordForTest({
      id: 'legacy-surface',
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      token,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 3_600_000,
    });

    const RED: NodeRedPluginAPI = {
      settings: {
        userDir: '/tmp/legacy-kind',
        httpAdminRoot: '/',
        adminAuth: { type: 'credentials' },
        aiAccess: { allowWithoutAdminAuth: true },
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
      flowAdapter: {
        kind: 'red',
        getFlows: () => Promise.resolve({ rev: 'r', flows: [] }),
        getFlow: () => Promise.resolve({ rev: 'r', flow: { id: 't', type: 'tab', nodes: [] } }),
        updateFlow: () => Promise.resolve({ rev: 'r2' }),
      },
    });

    const ok = await request(app).get(`/mcp/a/${token}/status`);
    expect(ok.status).toBe(200);

    const restReject = await request(app)
      .get('/mcp/api/v1/flows')
      .set('Authorization', `Bearer ${token}`);
    expect(restReject.status).toBe(403);
    expect(restReject.body.code).toBe('wrong_token_kind');
    expect(restReject.body.actualKind).toBe('get_link');
  });
});
