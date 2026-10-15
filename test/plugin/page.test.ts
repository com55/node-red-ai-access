/**
 * /mcp admin page — public boot shell + API auth via editor localStorage Bearer.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import type { AiAccessSettings, NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter } from '../../src/runtime/types.js';

interface MockUser {
  username: string;
  permissions: string | string[];
}

function createApp(options: {
  userDir: string;
  adminAuth?: unknown;
  aiAccess?: AiAccessSettings;
  httpAdminRoot?: string;
  authenticate?: (req: Request, _res: Response, next: NextFunction) => void;
}): { app: Express; linkStore: AccessLinkStore } {
  const app = express();
  app.use(express.json());

  const authenticate =
    options.authenticate ??
    ((_req: Request, _res: Response, next: NextFunction) => {
      next();
    });

  const linkStore = new AccessLinkStore({ maxActiveLinks: 10 });

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir: options.userDir,
      httpAdminRoot: options.httpAdminRoot ?? '/',
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
        // unused — registerRoutes called directly
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  const adapter: FlowAdapter = {
    kind: 'red',
    getFlows: () => Promise.resolve({ rev: 'rev-1', flows: [] }),
    getFlow: () =>
      Promise.resolve({
        rev: 'rev-1',
        flow: { id: 'tab-1', type: 'tab', label: 'Main', nodes: [] },
      }),
    updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
  };

  registerRoutes(RED, { linkStore, flowAdapter: adapter });
  return { app, linkStore };
}

function asUser(permissions: string | string[], username = 'user') {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: MockUser }).user = { username, permissions };
    next();
  };
}

describe('/mcp admin page', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-page-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('serves GET /mcp without server-side auth (client reads editor localStorage)', async () => {
    const { app } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
      httpAdminRoot: '/editor',
    });

    const res = await request(app).get('/mcp');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/data-config=/);
    expect(res.text).toMatch(/editorRoot/);
    expect(res.text).toMatch(/auth-tokens-editor/);
    expect(res.text).toMatch(/localStorage/);
    expect(res.text).toMatch(/id="section-status"/);
    expect(res.text).toMatch(/id="section-links"/);
    expect(res.text).toMatch(/id="section-proposals"/);
    expect(res.text).toMatch(/id="section-logs"/);
    expect(res.text).toMatch(/id="logs-filter"/);
    expect(res.text).toMatch(/auditSummary|audit-summary|fmtCompact/);
    expect(res.text).toMatch(/proposals\/.*\/diff|loadProposalDiff/);
    expect(res.text).toMatch(/accessLinkCopyText|Copy link for AI|token-copy-btn/);
    expect(res.text).toMatch(/mcpRpc|openapi\.yaml|Discovery \(no auth\)/);
  });

  it('keeps /mcp/api/v1/status behind admin auth', async () => {
    const { app } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
    });

    const unauth = await request(app).get('/mcp/api/v1/status');
    expect(unauth.status).toBe(401);

    const { app: app2 } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
      authenticate: asUser('*', 'admin'),
    });
    const auth = await request(app2).get('/mcp/api/v1/status');
    expect(auth.status).toBe(200);
    expect(auth.body.caller).toMatchObject({ kind: 'admin', permission: '*' });
  });

  it('exposes defaults on status for the page client', async () => {
    const { app } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
      aiAccess: {
        defaultLinkTtlSeconds: 3600,
        maxActiveLinks: 5,
        defaultDeploymentType: 'flows',
      },
      authenticate: asUser('*', 'admin'),
    });

    const status = await request(app).get('/mcp/api/v1/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      defaultLinkTtlSeconds: 3600,
      maxActiveLinks: 5,
      defaultDeploymentType: 'flows',
      caller: { kind: 'admin', permission: '*' },
    });
  });

  it('embeds client script that redirects when editor token is missing', async () => {
    const { app } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
    });
    const res = await request(app).get('/mcp');
    expect(res.text).toMatch(/readEditorToken|localStorage\.getItem/);
    expect(res.text).toMatch(/location\.replace/);
  });

  it('client only redirects on /status 401, not on other API 401s', async () => {
    const { app } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
    });
    const res = await request(app).get('/mcp');
    expect(res.text).toMatch(/isStatusPath/);
    expect(res.text).toMatch(/Only the auth bootstrap/);
    // Must not redirect on every 401 (that caused an /mcp ↔ editor loop).
    expect(res.text).not.toMatch(/if \(res\.status === 401\) \{\s*redirectToEditorLogin/);
  });

  it('admin session Bearer works on every /mcp/api/v1 route the page uses', async () => {
    // Simulates Chrome editor localStorage Bearer (not an aia_ access-link token).
    const editorBearer = 'nr-editor-access-token-not-an-access-link';
    const { app, linkStore } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
      authenticate: (req, _res, next) => {
        const auth = req.headers.authorization;
        if (auth === `Bearer ${editorBearer}`) {
          (req as Request & { user?: MockUser }).user = {
            username: 'admin',
            permissions: '*',
          };
        }
        next();
      },
    });

    // Seed a proposal via access link so GET /proposals has something to list.
    const link = linkStore.create({ label: 'seed' });
    const seeded = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: {
          flowId: 'tab-1',
          flow: { id: 'tab-1', type: 'tab', label: 'Main', nodes: [] },
        },
      });
    expect(seeded.status).toBe(201);

    const auth = { Authorization: `Bearer ${editorBearer}` };

    const status = await request(app).get('/mcp/api/v1/status').set(auth);
    expect(status.status).toBe(200);
    expect(status.body.caller).toMatchObject({ kind: 'admin', permission: '*' });

    const links = await request(app).get('/mcp/api/v1/links').set(auth);
    expect(links.status).toBe(200);
    expect(Array.isArray(links.body.links)).toBe(true);

    const logs = await request(app).get('/mcp/api/v1/logs?limit=100').set(auth);
    expect(logs.status).toBe(200);
    expect(Array.isArray(logs.body.logs)).toBe(true);

    // Regression: previously returned 401 access_link_invalid for editor Bearer.
    const proposals = await request(app).get('/mcp/api/v1/proposals').set(auth);
    expect(proposals.status).toBe(200);
    expect(proposals.body.proposals).toHaveLength(1);
    expect(proposals.body.code).toBeUndefined();
  });

  it('unknown aia_ Bearer on /proposals still returns access_link_invalid', async () => {
    const { app } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
      authenticate: asUser('*', 'admin'),
    });
    const res = await request(app)
      .get('/mcp/api/v1/proposals')
      .set('Authorization', 'Bearer aia_not-a-real-link-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('access_link_invalid');
  });
});
