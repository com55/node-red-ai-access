import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import {
  accessTokenRateLimitKey,
  resolveRateLimitConfig,
  sendRateLimited,
} from '../../src/plugin/rate-limit.js';
import type { AiAccessSettings, NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter } from '../../src/runtime/types.js';

function createApp(options: {
  userDir: string;
  aiAccess?: AiAccessSettings;
  adminAuth?: unknown;
}): { app: Express; linkStore: AccessLinkStore } {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 10, defaultTtlSeconds: 14_400 });
  const adapter = {
    kind: 'red',
    getFlows: () => Promise.resolve({ rev: 'rev-1', flows: [{ id: 'tab-1', type: 'tab' }] }),
    getFlow: (id: string) =>
      Promise.resolve({ rev: 'rev-1', flow: { id, type: 'tab', nodes: [] } }),
    updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
  } as FlowAdapter;

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir: options.userDir,
      httpAdminRoot: '/',
      adminAuth: options.adminAuth === undefined ? { type: 'credentials' } : options.adminAuth,
      aiAccess: {
        defaultDeploymentType: 'nodes',
        defaultLinkTtlSeconds: 14_400,
        allowWithoutAdminAuth: true,
        ...options.aiAccess,
      },
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

  registerRoutes(RED, { linkStore, flowAdapter: adapter });
  return { app, linkStore };
}

describe('resolveRateLimitConfig', () => {
  it('uses generous built-in defaults', () => {
    expect(resolveRateLimitConfig()).toEqual({
      windowMs: 60_000,
      maxPerIp: 600,
      maxPerToken: 300,
    });
  });

  it('reads aiAccess rateLimit* overrides', () => {
    expect(
      resolveRateLimitConfig({
        rateLimitWindowMs: 30_000,
        rateLimitMaxPerIp: 12,
        rateLimitMaxPerToken: 5,
      })
    ).toEqual({ windowMs: 30_000, maxPerIp: 12, maxPerToken: 5 });
  });
});

describe('accessTokenRateLimitKey', () => {
  it('prefers accessLink id, then path token, then Bearer', () => {
    expect(
      accessTokenRateLimitKey({
        accessLink: { id: 'link-1' },
      } as never)
    ).toBe('token:link:link-1');
    expect(accessTokenRateLimitKey({ params: { token: 'aia_abc' } } as never)).toBe(
      'token:path:aia_abc'
    );
    expect(
      accessTokenRateLimitKey({
        params: {},
        get: () => 'Bearer aia_deadbeef0123456789',
        headers: {},
      } as never)
    ).toMatch(/^token:bearer:aia_deadbeef/);
    expect(
      accessTokenRateLimitKey({ params: {}, get: () => undefined, headers: {} } as never)
    ).toBe(null);
  });
});

describe('sendRateLimited', () => {
  it('sets Retry-After and JSON code rate_limited', async () => {
    const app = express();
    app.get('/x', (req, res) => {
      (req as Request & { rateLimit?: { resetTime: Date } }).rateLimit = {
        resetTime: new Date(Date.now() + 12_000),
      };
      sendRateLimited(req, res, 60_000);
    });
    const res = await request(app).get('/x');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
    expect(res.body).toMatchObject({
      code: 'rate_limited',
      retryAfter: expect.any(Number),
    });
    expect(res.body.retryAfter).toBeGreaterThanOrEqual(1);
  });
});

describe('/mcp rate limiting integration', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-rate-limit-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('returns 429 JSON with retryAfter when /mcp/api per-IP limit is exceeded', async () => {
    const { app } = createApp({
      userDir,
      aiAccess: {
        rateLimitWindowMs: 60_000,
        rateLimitMaxPerIp: 3,
        rateLimitMaxPerToken: 100,
      },
    });

    const hits = [];
    for (let i = 0; i < 4; i += 1) {
      hits.push(await request(app).get('/mcp/api/v1'));
    }
    expect(hits.slice(0, 3).every(r => r.status === 200)).toBe(true);
    const limited = hits[3]!;
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.body).toMatchObject({
      code: 'rate_limited',
      retryAfter: expect.any(Number),
    });
  });

  it('returns 429 JSON with retryAfter when /mcp/a per-token limit is exceeded', async () => {
    const { app, linkStore } = createApp({
      userDir,
      adminAuth: false,
      aiAccess: {
        allowWithoutAdminAuth: true,
        rateLimitWindowMs: 60_000,
        rateLimitMaxPerIp: 1000,
        rateLimitMaxPerToken: 2,
      },
    });
    const created = linkStore.create({ label: 'rl' });
    const url = `/mcp/a/${created.token}/status`;
    expect((await request(app).get(url)).status).toBe(200);
    expect((await request(app).get(url)).status).toBe(200);
    const limited = await request(app).get(url);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.body).toMatchObject({
      code: 'rate_limited',
      retryAfter: expect.any(Number),
    });
  });

  it('enforces a separate per-IP bucket on /mcp/a before the token bucket', async () => {
    const { app, linkStore } = createApp({
      userDir,
      adminAuth: false,
      aiAccess: {
        allowWithoutAdminAuth: true,
        rateLimitWindowMs: 60_000,
        rateLimitMaxPerIp: 2,
        rateLimitMaxPerToken: 100,
      },
    });
    const created = linkStore.create({ label: 'rl-ip' });
    const url = `/mcp/a/${created.token}/status`;
    expect((await request(app).get(url)).status).toBe(200);
    expect((await request(app).get(url)).status).toBe(200);
    const limited = await request(app).get(url);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate_limited');
  });
});
