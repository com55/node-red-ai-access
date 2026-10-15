/**
 * GET/PUT /mcp/api/v1/settings — permissions and hot persistence.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      aiAccess: {
        defaultDeploymentType: 'nodes',
        defaultLinkTtlSeconds: 86400,
        ...(options.aiAccess ?? {}),
      },
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
    bindSettingsStore(null);
    rmSync(userDir, { recursive: true, force: true });
  });

  it('lets read users GET (canEdit false) and blocks PUT', async () => {
    const { app } = createApp({ userDir, authenticate: asUser('read', 'guest') });

    const got = await request(app).get('/mcp/api/v1/settings');
    expect(got.status).toBe(200);
    expect(got.body.canEdit).toBe(false);
    expect(got.body.settings.defaultDeploymentType).toBe('nodes');
    expect(got.body.precedence).toEqual(['disk', 'settings.js', 'default']);
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
});
