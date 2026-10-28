/**
 * Plugin scaffold tests — routes, auth gates, settings hook.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import registerAiAccessPlugin from '../../src/plugin/index.js';
import type { AiAccessSettings, NodeRedPluginAPI } from '../../src/plugin/types.js';

interface MockUser {
  username: string;
  permissions: string | string[];
}

function createMockRed(options: {
  adminAuth?: unknown;
  aiAccess?: AiAccessSettings;
  userDir?: string;
  httpAdminRoot?: string;
  authenticate?: (req: Request, _res: Response, next: NextFunction) => void;
}): { app: Express; RED: NodeRedPluginAPI; registeredPlugins: string[] } {
  const app = express();
  const registeredPlugins: string[] = [];
  const userDir = options.userDir ?? '/tmp/node-red-user';
  const httpAdminRoot = options.httpAdminRoot ?? '/';

  const authenticate =
    options.authenticate ??
    ((_req: Request, _res: Response, next: NextFunction) => {
      next();
    });

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir,
      httpAdminRoot,
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
      registerPlugin(id: string, definition?: Record<string, unknown>) {
        registeredPlugins.push(id);
        const onadd = definition?.onadd;
        if (typeof onadd === 'function') {
          (onadd as () => void)();
        }
      },
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };

  registerAiAccessPlugin(RED);
  return { app, RED, registeredPlugins };
}

describe('AI Access plugin scaffold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the plugin id with RED.plugins', () => {
    const { registeredPlugins } = createMockRed({ adminAuth: { type: 'credentials' } });
    expect(registeredPlugins).toContain('com55-ai-access');
  });

  it('rate-limits /mcp routes (RateLimit headers present)', async () => {
    const { app } = createMockRed({
      adminAuth: { type: 'credentials' },
      authenticate: (req, _res, next) => {
        (req as Request & { user?: MockUser }).user = {
          username: 'admin',
          permissions: '*',
        };
        next();
      },
    });

    const res = await request(app).get('/mcp/api/v1/status');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit'] ?? res.headers['x-ratelimit-limit']).toBeDefined();
  });

  describe('with adminAuth enabled', () => {
    it('serves GET /mcp without server auth (client uses editor localStorage Bearer)', async () => {
      const { app } = createMockRed({
        adminAuth: { type: 'credentials' },
        httpAdminRoot: '/admin',
      });

      const res = await request(app).get('/ai-access');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/localStorage/);
      expect(res.text).toMatch(/auth-tokens-admin/);
      expect(res.text).toMatch(/editorRoot/);
      expect(res.text).toMatch(/\\\/admin|\/admin/);
    });

    it('serves editor sidebar JS with no-store cache headers', async () => {
      const { app } = createMockRed({ adminAuth: { type: 'credentials' } });
      const res = await request(app).get('/mcp/editor/ai-access-sidebar.js');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
      expect(res.headers['x-ai-access-sidebar-version']).toBeTruthy();
      expect(res.text).toMatch(/RED\.sidebar\.addTab/);
      expect(res.text).toMatch(/Open AI Access dashboard/);
      expect(res.text).not.toMatch(/ai-access-save/);
    });

    it('returns 401 access_link_missing for unauthenticated GET /mcp/api/v1/status', async () => {
      const { app } = createMockRed({ adminAuth: { type: 'credentials' } });

      const res = await request(app).get('/mcp/api/v1/status');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        error: expect.stringMatching(/access link/i),
        code: 'access_link_missing',
      });
    });

    it('allows a read user to view status as read-only', async () => {
      const { app } = createMockRed({
        adminAuth: { type: 'credentials' },
        authenticate: (req, _res, next) => {
          (req as Request & { user?: MockUser }).user = {
            username: 'guest',
            permissions: 'read',
          };
          next();
        },
      });

      const page = await request(app).get('/ai-access');
      expect(page.status).toBe(200);
      expect(page.text).toMatch(/AI Access/i);
      expect(page.text).toMatch(/id="section-status"/);

      const status = await request(app).get('/mcp/api/v1/status');
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        ok: true,
        adminAuthEnabled: true,
        aiFeaturesEnabled: true,
        permission: 'read',
        capabilities: {
          view: true,
          manageLinks: false,
          approveProposals: false,
        },
        caller: { kind: 'admin', permission: 'read' },
      });
      expect(status.body.storageDir).toMatch(/\.ai-access$/);
    });

    it('grants full capabilities to a * user', async () => {
      const { app } = createMockRed({
        adminAuth: { type: 'credentials' },
        authenticate: (req, _res, next) => {
          (req as Request & { user?: MockUser }).user = {
            username: 'admin',
            permissions: '*',
          };
          next();
        },
      });

      const status = await request(app).get('/mcp/api/v1/status');
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        permission: '*',
        capabilities: {
          view: true,
          manageLinks: true,
          approveProposals: true,
        },
      });
    });
  });

  describe('without adminAuth', () => {
    it('serves /mcp shell; status reports AI features disabled by default', async () => {
      const { app } = createMockRed({});

      const page = await request(app).get('/ai-access');
      expect(page.status).toBe(200);
      expect(page.text).toMatch(/AI Access/i);
      expect(page.text).toMatch(/localStorage/);

      const status = await request(app).get('/mcp/api/v1/status');
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        adminAuthEnabled: false,
        aiFeaturesEnabled: false,
        allowWithoutAdminAuth: false,
      });
    });

    it('enables AI features when aiAccess.allowWithoutAdminAuth is true', async () => {
      const { app } = createMockRed({
        aiAccess: { allowWithoutAdminAuth: true },
      });

      const status = await request(app).get('/mcp/api/v1/status');
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        adminAuthEnabled: false,
        aiFeaturesEnabled: true,
        allowWithoutAdminAuth: true,
        permission: '*',
        capabilities: {
          view: true,
          manageLinks: true,
          approveProposals: true,
        },
      });
    });
  });

  it('resolves storage under RED.settings.userDir/.ai-access', async () => {
    const userDir = '/tmp/node-red-user-storage-check';
    const { app } = createMockRed({
      adminAuth: { type: 'credentials' },
      userDir,
      authenticate: (req, _res, next) => {
        (req as Request & { user?: MockUser }).user = {
          username: 'admin',
          permissions: '*',
        };
        next();
      },
    });

    const status = await request(app).get('/mcp/api/v1/status');
    expect(status.body.storageDir).toBe(`${userDir}/.ai-access`);
  });
});
