/**
 * Access-link admin routes and Bearer middleware tests.
 */

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
import registerAiAccessPlugin from '../../src/plugin/index.js';
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
      token: expect.stringMatching(/^aia_/),
      label: 'agent',
    });

    const listed = await request(app).get('/mcp/api/v1/links');
    expect(listed.status).toBe(200);
    expect(listed.body.links).toHaveLength(1);
    expect(listed.body.links[0]).not.toHaveProperty('token');
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);

    const revoked = await request(app).delete(`/mcp/api/v1/links/${created.body.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ revoked: true });

    const after = await request(app).get('/mcp/api/v1/links');
    expect(after.body.links).toHaveLength(0);
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
});

describe('requireAccessLink middleware', () => {
  function probeApp(RED: NodeRedPluginAPI, store: AccessLinkStore) {
    const app = express();
    const limiter = createAiAccessRateLimiter();
    app.get('/probe', limiter, requireAccessLink(RED, store), (req, res) => {
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
});
