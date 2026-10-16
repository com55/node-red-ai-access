/**
 * REST /mcp/api/v1 usable by a plain (non-MCP) AI with only an access link + HTTP.
 *
 * Covers: shared-read 401 codes, /status for access links, flow.type, JSON 404,
 * and unauthenticated discovery index.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import {
  ACCESS_LINK_INVALID_CODE,
  ACCESS_LINK_INVALID_MESSAGE,
  ACCESS_LINK_MISSING_CODE,
  ACCESS_LINK_MISSING_MESSAGE,
  ACCESS_LINK_WWW_AUTHENTICATE,
} from '../../src/plugin/access-link-auth.js';
import { registerRoutes } from '../../src/plugin/index.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter } from '../../src/runtime/types.js';

interface MockUser {
  username: string;
  permissions: string | string[];
}

function createApp(options: {
  userDir: string;
  authenticate?: (req: Request, _res: Response, next: NextFunction) => void;
  /** Simulate passport WWW-Authenticate realm=Users on failed needsPermission. */
  passportStyle401?: boolean;
  adapter?: FlowAdapter;
}): {
  app: Express;
  linkStore: AccessLinkStore;
} {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const linkStore = new AccessLinkStore({ maxActiveLinks: 10 });
  const authenticate =
    options.authenticate ??
    ((_req: Request, res: Response, _next: NextFunction) => {
      if (options.passportStyle401) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="Users"');
        res.status(401).end('Unauthorized');
        return;
      }
      res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
    });

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir: options.userDir,
      httpAdminRoot: '/',
      adminAuth: { type: 'credentials' },
      aiAccess: { defaultDeploymentType: 'nodes' },
    },
    httpAdmin: app,
    auth: {
      needsPermission(_permission: string) {
        return (req: Request, res: Response, next: NextFunction) => {
          authenticate(req, res, (err?: unknown) => {
            if (err) {
              next(err as Error);
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

  const adapter: FlowAdapter =
    options.adapter ??
    ({
      kind: 'red',
      getFlows: () =>
        Promise.resolve({
          rev: 'rev-1',
          flows: [{ id: 'tab-1', type: 'tab', label: 'Main' }],
        }),
      getFlow: (id: string) =>
        Promise.resolve({
          rev: 'rev-1',
          // Simulate Node-RED omitting `type` on getFlow.
          flow: {
            id,
            label: 'Main',
            nodes: [{ id: 'n1', type: 'inject', z: id }],
          },
        }),
      updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
    } as FlowAdapter);

  registerRoutes(RED, { linkStore, flowAdapter: adapter });
  return { app, linkStore };
}

function asUser(permissions: string | string[], username = 'admin') {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: MockUser }).user = { username, permissions };
    next();
  };
}

describe('REST access-link UX', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-rest-ux-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('GET /flows without token returns access_link_missing (not auth_required / Users realm)', async () => {
    const { app } = createApp({ userDir, passportStyle401: true });

    const res = await request(app).get('/mcp/api/v1/flows');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({
      error: ACCESS_LINK_MISSING_MESSAGE,
      code: ACCESS_LINK_MISSING_CODE,
    });
    expect(res.headers['www-authenticate']).toBe(ACCESS_LINK_WWW_AUTHENTICATE);
    expect(res.headers['www-authenticate']).not.toMatch(/Users/);
    expect(res.text).not.toBe('Unauthorized');
  });

  it('GET /flows with invalid aia_ token returns access_link_invalid', async () => {
    const { app } = createApp({ userDir, passportStyle401: true });

    const res = await request(app)
      .get('/mcp/api/v1/flows')
      .set('Authorization', 'Bearer aia_not-real');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: ACCESS_LINK_INVALID_MESSAGE,
      code: ACCESS_LINK_INVALID_CODE,
    });
    expect(String(res.body.hint ?? '')).toMatch(/truncated/i);
    expect(res.headers['www-authenticate']).toBe(ACCESS_LINK_WWW_AUTHENTICATE);
  });

  it('GET /flows with Bearer bogus returns access_link_invalid (not missing)', async () => {
    const { app } = createApp({ userDir, passportStyle401: true });

    const res = await request(app).get('/mcp/api/v1/flows').set('Authorization', 'Bearer bogus');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ACCESS_LINK_INVALID_CODE);
    expect(res.body.code).not.toBe(ACCESS_LINK_MISSING_CODE);
    expect(String(res.body.hint ?? '')).toMatch(/truncated/i);
  });

  it('GET /flows still allows admin session without Bearer', async () => {
    const { app } = createApp({ userDir, authenticate: asUser('*') });
    const res = await request(app).get('/mcp/api/v1/flows');
    expect(res.status).toBe(200);
    expect(res.body.rev).toBe('rev-1');
  });

  it('GET /status accepts access-link Bearer and returns caller info', async () => {
    const { app, linkStore } = createApp({ userDir, passportStyle401: true });
    const link = linkStore.create({ kind: 'rest', label: 'claude-session', ttlSeconds: 3600 });

    const res = await request(app)
      .get('/mcp/api/v1/status')
      .set('Authorization', `Bearer ${link.token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.permission).toBeNull();
    expect(res.body.caller).toMatchObject({
      kind: 'access-link',
      linkId: link.id,
      label: 'claude-session',
    });
    expect(typeof res.body.caller.expiresAt).toBe('string');
    expect(Array.isArray(res.body.caller.permissions)).toBe(true);
    expect(res.body.caller.permissions.length).toBeGreaterThan(0);
    expect(res.body.caller.baseUrls).toMatchObject({
      api: '/mcp/api/v1',
      rpc: '/mcp/rpc',
      openapi: '/mcp/api/v1/openapi.yaml',
      discovery: '/mcp/api/v1',
    });
  });

  it('GET /status without auth still returns auth_required for admin page bootstrap', async () => {
    const { app } = createApp({ userDir });
    const res = await request(app).get('/mcp/api/v1/status');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('auth_required');
  });

  it('GET /flows/:id always includes flow.type (defaults to tab)', async () => {
    const { app, linkStore } = createApp({ userDir, authenticate: asUser('*') });
    const link = linkStore.create({ kind: 'rest', label: 'type-check' });

    const res = await request(app)
      .get('/mcp/api/v1/flows/tab-1')
      .set('Authorization', `Bearer ${link.token}`);
    expect(res.status).toBe(200);
    expect(res.body.flow).toMatchObject({ id: 'tab-1', type: 'tab' });
    expect(Array.isArray(res.body.flow.nodes)).toBe(true);
  });

  it('unknown /mcp/api/v1 routes return JSON 404 not_found', async () => {
    const { app } = createApp({ userDir, authenticate: asUser('*') });

    const missing = await request(app).get('/mcp/api/v1/no-such-route');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toMatch(/json/);
    expect(missing.body).toEqual({
      error: 'Not found',
      code: 'not_found',
    });
    expect(missing.text).not.toMatch(/Cannot GET|<html/i);

    const emptyId = await request(app).get('/mcp/api/v1/proposals//diff');
    expect(emptyId.status).toBe(404);
    expect(emptyId.body.code).toBe('not_found');
  });

  it('GET /mcp/api/v1 discovery index is public and lists auth + endpoints', async () => {
    const { app } = createApp({ userDir, passportStyle401: true });

    const res = await request(app).get('/mcp/api/v1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.ok).toBe(true);
    expect(res.body.auth).toMatchObject({
      scheme: 'Bearer',
      header: 'Authorization: Bearer <token>',
    });
    expect(res.body.openapi).toBe('/mcp/api/v1/openapi.yaml');
    expect(res.body.mcp).toBe('/mcp/rpc');
    expect(Array.isArray(res.body.endpoints)).toBe(true);
    expect(res.body.endpoints.some((e: { path?: string }) => e.path === '/flows')).toBe(true);
    expect(res.body.endpoints.some((e: { path?: string }) => e.path === '/status')).toBe(true);
    expect(res.body.getLink?.canMintTokens).toBe(false);
    expect(res.body.auth.mint?.method).toBe('POST');
    expect(res.body.auth.mint?.path).toBe('/links');
  });

  it('OpenAPI includes Quick start for access-link clients with CreateProposalRequest example', async () => {
    const { app } = createApp({ userDir });
    const res = await request(app).get('/mcp/api/v1/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Quick start for access-link clients/i);
    expect(res.text).toMatch(/CreateProposalRequest/);
    expect(res.text).toMatch(/replace_flow/);
    expect(res.text).toMatch(/expectedRev/);
    expect(res.text).toMatch(/Authorization: Bearer/);
    expect(res.text).toMatch(/AccessLinkKind/);
    expect(res.text).toMatch(/wrong_token_kind/);
    expect(res.text).toMatch(/invalid_link_kind/);
    expect(res.text).toMatch(/never mints tokens|no link-create operation/i);
  });
});
