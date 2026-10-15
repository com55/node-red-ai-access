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
});
