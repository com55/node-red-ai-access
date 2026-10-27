/**
 * GET/PUT /mcp/api/v1/settings — permissions and hot persistence.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindPublicBaseUrl, requestPublicOrigin } from '../../src/plugin/access-path.js';
import { registerRoutes } from '../../src/plugin/index.js';
import { areAiFeaturesEnabled, bindSettingsStore } from '../../src/plugin/settings.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter } from '../../src/runtime/types.js';
import { resolveAiAccessPaths } from '../../src/storage/paths.js';

interface MockUser {
  username: string;
  permissions: string | string[];
}

function createApp(options: {
  userDir: string;
  authenticate: (req: Request, _res: Response, next: NextFunction) => void;
  adminAuth?: unknown;
  aiAccess?: Record<string, unknown>;
}): { app: Express; RED: NodeRedPluginAPI } {
  const app = express();
  app.use(express.json());

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir: options.userDir,
      httpAdminRoot: '/',
      adminAuth: options.adminAuth ?? { type: 'credentials' },
      aiAccess: options.aiAccess ?? {},
    },
    httpAdmin: app,
    auth: {
      needsPermission(permission: string) {
        return (req: Request, res: Response, next: NextFunction) => {
          options.authenticate(req, res, (err?: unknown) => {
            if (err) {
              next(err as Error);
              return;
            }
            const user = (req as Request & { user?: MockUser }).user;
            if (!user) {
              res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
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
        return undefined;
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  const adapter: FlowAdapter = {
    kind: 'red',
    getFlows: () => Promise.resolve({ rev: 'r', flows: [] }),
    getFlow: () => Promise.resolve({ rev: 'r', flow: { id: 't', type: 'tab', nodes: [] } }),
    updateFlow: () => Promise.resolve({ rev: 'r2' }),
  };

  registerRoutes(RED, { flowAdapter: adapter });
  return { app, RED };
}

function asUser(permissions: string | string[], username = 'user') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    (req as Request & { user?: MockUser }).user = { username, permissions };
    next();
  };
}

describe('GET/PUT /mcp/api/v1/settings', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-settings-api-'));
  });

  afterEach(() => {
    bindPublicBaseUrl(undefined);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    bindSettingsStore(null);
    rmSync(userDir, { recursive: true, force: true });
  });

  it('lets read users GET (canEdit false) and blocks PUT', async () => {
    const { app } = createApp({ userDir, authenticate: asUser('read', 'guest') });

    const got = await request(app).get('/mcp/api/v1/settings');
    expect(got.status).toBe(200);
    expect(got.body.canEdit).toBe(false);
    expect(got.body.settings.defaultDeploymentType).toBe('nodes');
    expect(got.body.precedence).toEqual(['settings.js', 'disk', 'default']);
    expect(got.body.mcpPageUrl).toBe('/mcp');

    const put = await request(app)
      .put('/mcp/api/v1/settings')
      .send({ defaultDeploymentType: 'full' });
    expect(put.status).toBe(403);
  });

  it('lets * users PUT and persists to disk; runtime picks up without restart', async () => {
    const { app, RED } = createApp({ userDir, authenticate: asUser('*', 'admin') });

    expect(areAiFeaturesEnabled(RED.settings)).toBe(true);

    const put = await request(app).put('/mcp/api/v1/settings').send({
      enabled: false,
      defaultDeploymentType: 'flows',
      defaultLinkTtlSeconds: 3600,
    });
    expect(put.status).toBe(200);
    expect(put.body.canEdit).toBe(true);
    expect(put.body.settings).toMatchObject({
      enabled: false,
      defaultDeploymentType: 'flows',
      defaultLinkTtlSeconds: 3600,
    });
    expect(put.body.sources.defaultDeploymentType).toBe('disk');

    const settingsPath = resolveAiAccessPaths(userDir).settings;
    expect(existsSync(settingsPath)).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({
      enabled: false,
      defaultDeploymentType: 'flows',
      defaultLinkTtlSeconds: 3600,
    });

    // Hot reload: same process, no restart.
    expect(areAiFeaturesEnabled(RED.settings)).toBe(false);

    const status = await request(app).get('/mcp/api/v1/status');
    expect(status.status).toBe(200);
    expect(status.body.aiAccessEnabled).toBe(false);
    expect(status.body.aiFeaturesEnabled).toBe(false);
    expect(status.body.defaultDeploymentType).toBe('flows');
    expect(status.body.defaultLinkTtlSeconds).toBe(3600);

    // Re-enable
    const again = await request(app).put('/mcp/api/v1/settings').send({ enabled: true });
    expect(again.status).toBe(200);
    expect(areAiFeaturesEnabled(RED.settings)).toBe(true);
  });

  it('rejects unauthenticated settings access', async () => {
    const { app } = createApp({
      userDir,
      authenticate: (_req, _res, next) => next(),
    });
    const got = await request(app).get('/mcp/api/v1/settings');
    expect(got.status).toBe(401);
  });
  it('ignores every locked key, including invalid submitted values', async () => {
    const { app } = createApp({
      userDir,
      authenticate: asUser('*'),
      aiAccess: {
        enabled: true,
        publicBaseUrl: 'https://locked.example',
        corsAllowedOrigins: [],
        rateLimitMaxPerIp: 100,
        defaultLinkTtlSeconds: 1234,
        defaultDeploymentType: 'nodes',
        maxActiveLinks: 8,
        allowWithoutAdminAuth: false,
        rateLimitWindowMs: 10000,
        rateLimitMaxPerToken: 90,
      },
    });
    const result = await request(app)
      .put('/mcp/api/v1/settings')
      .send({
        enabled: false,
        publicBaseUrl: 'invalid',
        rateLimitMaxPerIp: -1,
        defaultLinkTtlSeconds: 99,
        defaultDeploymentType: 'full',
        maxActiveLinks: 1,
        allowWithoutAdminAuth: true,
        corsAllowedOrigins: ['bad'],
        rateLimitWindowMs: 1,
        rateLimitMaxPerToken: 1,
      });
    expect(result.status).toBe(200);
    expect(Object.values(result.body.sources)).toEqual(Array(10).fill('settings.js'));
    expect(result.body.settings.publicBaseUrl).toBe('https://locked.example');
    expect(result.body.settings.enabled).toBe(true);
    expect(result.body.disk).toEqual({});
  });

  it('applies Public URL, CORS and both rate limits immediately', async () => {
    const { app } = createApp({ userDir, authenticate: asUser('*') });
    const origin = 'https://browser.example';
    expect(
      (await request(app).get('/mcp/api/v1').set('Origin', origin)).headers[
        'access-control-allow-origin'
      ]
    ).toBeUndefined();
    const saved = await request(app)
      .put('/mcp/api/v1/settings')
      .send({
        publicBaseUrl: 'https://public.example/',
        corsAllowedOrigins: [origin],
        rateLimitMaxPerIp: 20,
        rateLimitMaxPerToken: 1,
        rateLimitWindowMs: 10000,
      });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.publicBaseUrl).toBe('https://public.example');
    expect(requestPublicOrigin({} as Request)).toBe('https://public.example');
    const link = await request(app).post('/mcp/api/v1/links').send({ kind: 'get_link' });
    expect(link.status).toBe(201);
    expect(link.body.url).toMatch(/^https:\/\/public\.example\/mcp\/a\//);
    const token = 'aia_abcdefghijklmnopqrstuvwxyz';
    const first = await request(app)
      .get('/mcp/api/v1')
      .set('Origin', origin)
      .set('Authorization', 'Bearer ' + token);
    expect(first.status).toBe(200);
    expect(first.headers['access-control-allow-origin']).toBe(origin);
    expect(
      (
        await request(app)
          .get('/mcp/api/v1')
          .set('Authorization', 'Bearer ' + token)
      ).status
    ).toBe(429);
    await request(app)
      .put('/mcp/api/v1/settings')
      .send({ rateLimitMaxPerIp: 1, rateLimitMaxPerToken: 10 });
    expect((await request(app).get('/mcp/api/v1')).status).toBe(200);
    expect((await request(app).get('/mcp/api/v1')).status).toBe(429);
  });

  it('uses a changed rate-limit window immediately', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const { app } = createApp({ userDir, authenticate: asUser('*') });
    await request(app).get('/mcp/api/v1');
    const saved = await request(app)
      .put('/mcp/api/v1/settings')
      .send({ rateLimitWindowMs: 50, rateLimitMaxPerIp: 1 });
    expect(saved.status).toBe(200);
    expect((await request(app).get('/mcp/api/v1')).status).toBe(200);
    expect((await request(app).get('/mcp/api/v1')).status).toBe(429);
    await vi.advanceTimersByTimeAsync(51);
    expect((await request(app).get('/mcp/api/v1')).status).toBe(200);
  });

  it.each([
    'https://public.example',
    'https://public.example/',
    'http://localhost:1880',
    'http://127.0.0.1:1880',
    '',
  ])('accepts Public URL %s', async publicBaseUrl => {
    const { app } = createApp({ userDir, authenticate: asUser('*') });
    expect((await request(app).put('/mcp/api/v1/settings').send({ publicBaseUrl })).status).toBe(
      200
    );
  });

  it.each([
    'http://example.com',
    'https://example.com/path',
    'https://example.com/?q=1',
    'https://example.com/#frag',
    'https://user:pass@example.com',
    'https://example.com/a/..',
    'junk',
  ])('rejects Public URL %s', async publicBaseUrl => {
    const { app } = createApp({ userDir, authenticate: asUser('*') });
    const result = await request(app).put('/mcp/api/v1/settings').send({ publicBaseUrl });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      code: 'invalid_body',
      error: expect.stringContaining('HTTPS origin'),
    });
  });

  it.each(['rateLimitWindowMs', 'rateLimitMaxPerIp', 'rateLimitMaxPerToken'])(
    'validates %s',
    async key => {
      const { app } = createApp({ userDir, authenticate: asUser('*') });
      for (const value of [0, -1, '10', null]) {
        const result = await request(app)
          .put('/mcp/api/v1/settings')
          .send({ [key]: value });
        expect(result.status).toBe(400);
        expect(result.body.error).toContain(key);
      }
    }
  );

  it('rejects invalid and mixed CORS entries without saving', async () => {
    const { app } = createApp({ userDir, authenticate: asUser('*') });
    for (const corsAllowedOrigins of [
      ['junk'],
      ['https://valid.example', 'junk'],
      ['https://example.com/path'],
      '*',
    ]) {
      expect(
        (await request(app).put('/mcp/api/v1/settings').send({ corsAllowedOrigins })).status
      ).toBe(400);
    }
    expect(
      (await request(app).get('/mcp/api/v1/settings')).body.settings.corsAllowedOrigins
    ).toEqual([]);
  });

  it('reports the effective trust proxy setting read-only', async () => {
    const { app } = createApp({ userDir, authenticate: asUser('*') });
    app.set('trust proxy', 'loopback');
    const result = await request(app).put('/mcp/api/v1/settings').send({ trustProxy: false });
    expect(result.body.trustProxy).toBe('loopback');
  });

  it('restricts Check to star users and validates its URL before fetching', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { app } = createApp({ userDir, authenticate: asUser('read') });
    expect(
      (
        await request(app)
          .post('/mcp/api/v1/settings/check-public-url')
          .send({ publicBaseUrl: 'https://example.com' })
      ).status
    ).toBe(403);
    const admin = createApp({ userDir, authenticate: asUser('*') }).app;
    expect(
      (
        await request(admin)
          .post('/mcp/api/v1/settings/check-public-url')
          .send({ publicBaseUrl: 'https://example.com/path' })
      ).status
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([200, 302, 503])('Check reports HTTP %s without following redirects', async status => {
    const fetcher = vi.fn().mockResolvedValue(new globalThis.Response(null, { status }));
    vi.stubGlobal('fetch', fetcher);
    const { app, RED } = createApp({ userDir, authenticate: asUser('*') });
    RED.settings.httpAdminRoot = '/red/';
    const result = await request(app)
      .post('/mcp/api/v1/settings/check-public-url')
      .send({ publicBaseUrl: 'https://example.com/' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: status === 200,
      status,
      url: 'https://example.com/red/mcp/api/v1',
    });
    expect(fetcher).toHaveBeenCalledWith('https://example.com/red/mcp/api/v1', {
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    });
  });

  it('Check reports network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
    const { app } = createApp({ userDir, authenticate: asUser('*') });
    const result = await request(app)
      .post('/mcp/api/v1/settings/check-public-url')
      .send({ publicBaseUrl: 'https://example.com' });
    expect(result.body).toMatchObject({
      ok: false,
      status: null,
      error: expect.stringContaining('Could not reach'),
    });
  });

  it('Check aborts after five seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let started!: () => void;
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener('abort', () => reject(new Error('aborted')));
            started();
          })
      )
    );
    const { app } = createApp({ userDir, authenticate: asUser('*') });
    const pending = request(app)
      .post('/mcp/api/v1/settings/check-public-url')
      .send({ publicBaseUrl: 'https://example.com' })
      .then(result => result);
    await ready;
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.body).toMatchObject({
      ok: false,
      status: null,
      error: expect.stringContaining('timed out'),
    });
  });
});
