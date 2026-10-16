/**
 * Token expiry UX: per-kind TTL caps, token_expired, status minutesRemaining,
 * and get_link >24h reset note in the /mcp page client.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AccessLinkStore,
  MAX_TTL_SECONDS_GET_LINK,
  MAX_TTL_SECONDS_REST_MCP,
} from '../../src/access/index.js';
import {
  ACCESS_LINK_EXPIRED_CODE,
  accessLinksPagePath,
} from '../../src/plugin/access-link-auth.js';
import { registerRoutes } from '../../src/plugin/index.js';
import { minutesRemainingUntil, secondsRemainingUntil } from '../../src/plugin/status.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';

interface MockUser {
  username: string;
  permissions: string | string[];
}

function asStarUser(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { user?: MockUser }).user = { username: 'admin', permissions: '*' };
  next();
}

function createApp(
  userDir: string,
  linkStore?: AccessLinkStore
): {
  app: Express;
  linkStore: AccessLinkStore;
} {
  const app = express();
  app.use(express.json());
  const store = linkStore ?? new AccessLinkStore({ maxActiveLinks: 20 });
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
          asStarUser(req, res, (err?: unknown) => {
            if (err) {
              next(err as Error);
              return;
            }
            const user = (req as Request & { user?: MockUser }).user;
            const scopes = user
              ? Array.isArray(user.permissions)
                ? user.permissions
                : [user.permissions]
              : [];
            if (!scopes.includes('*') && !scopes.includes(permission)) {
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
  registerRoutes(RED, { linkStore: store });
  return { app, linkStore: store };
}

describe('token expiry UX', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-ttl-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('rejects get_link TTL above 24h and rest/mcp above 30d', async () => {
    const { app } = createApp(userDir);

    const getTooLong = await request(app)
      .post('/mcp/api/v1/links')
      .send({ kind: 'get_link', ttlSeconds: MAX_TTL_SECONDS_GET_LINK + 1 });
    expect(getTooLong.status).toBe(400);
    expect(getTooLong.body.error).toMatch(/24 hours/);

    const restOk = await request(app)
      .post('/mcp/api/v1/links')
      .send({ kind: 'rest', ttlSeconds: MAX_TTL_SECONDS_REST_MCP });
    expect(restOk.status).toBe(201);

    const restTooLong = await request(app)
      .post('/mcp/api/v1/links')
      .send({ kind: 'rest', ttlSeconds: MAX_TTL_SECONDS_REST_MCP + 1 });
    expect(restTooLong.status).toBe(400);
    expect(restTooLong.body.error).toMatch(/30 days/);
  });

  it('returns token_expired for a known expired Bearer', async () => {
    let now = 1_000_000;
    const store = new AccessLinkStore({
      now: () => now,
      randomToken: () => 'aia_expire-ux',
    });
    const { app } = createApp(userDir, store);
    const created = store.create({ kind: 'rest', ttlSeconds: 30 });

    now += 60_000;
    const res = await request(app)
      .get('/mcp/api/v1/status')
      .set('Authorization', `Bearer ${created.token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ACCESS_LINK_EXPIRED_CODE);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('status includes expiresAt and minutesRemaining for access-link callers', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest', ttlSeconds: 7200 });
    const res = await request(app)
      .get('/mcp/api/v1/status')
      .set('Authorization', `Bearer ${link.token}`);
    expect(res.status).toBe(200);
    expect(res.body.caller.kind).toBe('access-link');
    expect(typeof res.body.caller.expiresAt).toBe('string');
    expect(res.body.caller.minutesRemaining).toBeGreaterThan(100);
    expect(res.body.caller.minutesRemaining).toBeLessThanOrEqual(120);
  });

  it.each([
    ['get_link over 24h', { kind: 'get_link', ttlSeconds: MAX_TTL_SECONDS_GET_LINK + 1 }],
    ['rest over 30d', { kind: 'rest', ttlSeconds: MAX_TTL_SECONDS_REST_MCP + 1 }],
    ['mcp over 30d', { kind: 'mcp', ttlSeconds: MAX_TTL_SECONDS_REST_MCP + 1 }],
    ['zero', { kind: 'rest', ttlSeconds: 0 }],
    ['negative', { kind: 'get_link', ttlSeconds: -5 }],
    ['non-number', { kind: 'rest', ttlSeconds: '3600' }],
  ])('rejects ttlSeconds %s with 400 invalid_ttl and per-kind caps hint', async (_n, body) => {
    const { app } = createApp(userDir);
    const res = await request(app).post('/mcp/api/v1/links').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_ttl');
    expect(res.body.code).not.toBe('access_link_invalid');
    expect(res.body.hint).toMatch(/get_link.*24h/);
    expect(res.body.hint).toMatch(/rest and mcp.*30 days/);
  });

  it('REST token_expired includes expiredAt, accessLinksUrl, and WWW-Authenticate', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const store = new AccessLinkStore({ now: () => now, randomToken: () => 'aia_exp-rest-0001' });
    const { app } = createApp(userDir, store);
    const created = store.create({ kind: 'rest', ttlSeconds: 30 });
    now += 60_000;
    const res = await request(app)
      .get('/mcp/api/v1/flows')
      .set('Host', 'nr.example:1880')
      .set('Authorization', `Bearer ${created.token}`);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
    expect(res.body.code).toBe('token_expired');
    expect(res.body.expiredAt).toBe(created.expiresAt);
    expect(res.body.accessLinksUrl).toBe('http://nr.example:1880/mcp#links');
    expect(res.body.hint).toMatch(/Access links/);
  });

  it('GET-link 401s (token_expired, access_link_invalid) include WWW-Authenticate', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const store = new AccessLinkStore({
      now: () => now,
      randomToken: () => 'aia_get-link-expiry-token-000000000000000',
    });
    const { app } = createApp(userDir, store);
    const created = store.create({ kind: 'get_link', ttlSeconds: 30 });
    now += 60_000;
    const expired = await request(app).get(`/mcp/a/${created.token}/status`);
    expect(expired.status).toBe(401);
    expect(expired.headers['www-authenticate']).toMatch(/^Bearer /);
    expect(expired.body.code).toBe('token_expired');
    expect(expired.body.expiredAt).toBe(created.expiresAt);
    expect(expired.body.accessLinksUrl).toMatch(/\/mcp#links$/);

    const invalid = await request(app).get(
      '/mcp/a/aia_unknown-token-that-is-long-enough-000000/status'
    );
    expect(invalid.status).toBe(401);
    expect(invalid.body.code).toBe('access_link_invalid');
    expect(invalid.headers['www-authenticate']).toMatch(/^Bearer /);
  });

  it('status reports minutesRemaining rounded up and secondsRemaining', async () => {
    const store = new AccessLinkStore({ maxActiveLinks: 5 });
    const { app } = createApp(userDir, store);
    const link = store.create({ kind: 'rest', ttlSeconds: 20 });
    const res = await request(app)
      .get('/mcp/api/v1/status')
      .set('Authorization', `Bearer ${link.token}`);
    expect(res.status).toBe(200);
    expect(res.body.caller.minutesRemaining).toBe(1);
    expect(res.body.caller.secondsRemaining).toBeGreaterThan(0);
    expect(res.body.caller.secondsRemaining).toBeLessThanOrEqual(20);
  });

  it('accessLinksPagePath respects httpAdminRoot', () => {
    expect(accessLinksPagePath(undefined)).toBe('/mcp#links');
    expect(accessLinksPagePath('/')).toBe('/mcp#links');
    expect(accessLinksPagePath('/admin/')).toBe('/admin/mcp#links');
    expect(accessLinksPagePath('/admin')).toBe('/admin/mcp#links');
  });

  it('minutesRemainingUntil rounds up (never 0 while valid) and never goes negative', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(minutesRemainingUntil('2026-01-01T00:59:59.000Z', now)).toBe(60);
    expect(minutesRemainingUntil('2026-01-01T01:00:00.000Z', now)).toBe(60);
    expect(minutesRemainingUntil('2026-01-01T00:00:30.000Z', now)).toBe(1);
    expect(minutesRemainingUntil('2026-01-01T00:00:00.001Z', now)).toBe(1);
    expect(minutesRemainingUntil('2026-01-01T00:00:00.000Z', now)).toBe(0);
    expect(minutesRemainingUntil('2025-12-31T23:00:00.000Z', now)).toBe(0);
  });

  it('secondsRemainingUntil rounds up and never goes negative', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(secondsRemainingUntil('2026-01-01T00:00:30.000Z', now)).toBe(30);
    expect(secondsRemainingUntil('2026-01-01T00:00:00.400Z', now)).toBe(1);
    expect(secondsRemainingUntil('2025-12-31T23:00:00.000Z', now)).toBe(0);
  });

  it('/mcp page client resets expiry to 1h when switching to get_link above 24h', async () => {
    const { app } = createApp(userDir);
    const page = await request(app).get('/mcp');
    expect(page.status).toBe(200);
    const html = page.text;
    // Dropdown includes 7d + Custom; 7d is hidden for get_link.
    expect(html).toMatch(/id="link-ttl-preset"/);
    expect(html).toMatch(/>7 days</);
    expect(html).toMatch(/value="custom">Custom</);
    expect(html).toMatch(/sevenDay\.hidden = kind === 'get_link'/);
    // Switching channel to get_link with 7d selected → reset to 1 hour + note.
    expect(html).toMatch(/kind === 'get_link' && sel && sel\.value === String\(TTL_PRESET_7D\)/);
    // Switching (or Custom) with value above 24h → same reset.
    expect(html).toMatch(/kind === 'get_link' && seconds > TTL_MAX_GET_LINK/);
    expect(html).toMatch(/applyTtlPresetValue\(TTL_PRESET_1H\)/);
    expect(html).toMatch(/id="link-ttl-reset-note"/);
    expect(html).toMatch(/Expiry reset to 1 hour \(GET links are capped at 24 hours\)/);
    // kind change re-runs updateTtlUiState (where the reset lives).
    expect(html).toMatch(
      /kindSelect\.addEventListener\('change',\s*function\s*\(\)\s*\{\s*updateTtlUiState\(\);/
    );
  });
});
