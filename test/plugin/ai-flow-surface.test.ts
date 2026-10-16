/**
 * AI-facing flow + proposal surface (access-link Bearer).
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

function createApp(options: { userDir: string; adapter?: FlowAdapter }): {
  app: Express;
  linkStore: AccessLinkStore;
} {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const linkStore = new AccessLinkStore({ maxActiveLinks: 10 });

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir: options.userDir,
      httpAdminRoot: '/',
      adminAuth: { type: 'credentials' },
      aiAccess: { defaultDeploymentType: 'nodes' },
    },
    httpAdmin: app,
    auth: {
      needsPermission() {
        return (_req: Request, _res: Response, next: NextFunction) => next();
      },
    },
    plugins: {
      registerPlugin() {
        // unused
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
          flows: [
            { id: 'tab-1', type: 'tab', label: 'Main' },
            { id: 'n1', type: 'inject', z: 'tab-1' },
          ],
        }),
      getFlow: (id: string) =>
        Promise.resolve({
          rev: 'rev-1',
          flow: {
            id,
            type: 'tab',
            label: 'Main',
            nodes: [{ id: 'n1', type: 'inject', z: id }],
            configs: [],
          },
        }),
      updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
    } as FlowAdapter);

  registerRoutes(RED, { linkStore, flowAdapter: adapter });
  return { app, linkStore };
}

describe('AI flow surface (access-link Bearer)', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-ai-surface-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('serves OpenAPI YAML for /mcp/api/v1/openapi.yaml', async () => {
    const { app } = createApp({ userDir });
    const res = await request(app).get('/mcp/api/v1/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/yaml|text/);
    expect(res.text).toMatch(/openapi:\s*3\.1\.0/);
    expect(res.text).toMatch(/\/flows/);
    expect(res.text).toMatch(/replace_flow/);
    expect(res.text).toMatch(/deploymentType/);
    expect(res.text).toMatch(/Ask the user for a new access link/);
  });

  it('lets an AI client read flows, get a tab, and submit replace_flow', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ kind: 'rest', label: 'claude' });
    const auth = { Authorization: `Bearer ${link.token}` };

    const list = await request(app).get('/mcp/api/v1/flows').set(auth);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ rev: 'rev-1' });
    expect(Array.isArray(list.body.flows)).toBe(true);

    const one = await request(app).get('/mcp/api/v1/flows/tab-1').set(auth);
    expect(one.status).toBe(200);
    expect(one.body.rev).toBe('rev-1');
    expect(one.body.flow).toMatchObject({ id: 'tab-1', type: 'tab' });

    const created = await request(app)
      .post('/mcp/api/v1/proposals?include=payload')
      .set(auth)
      .send({
        type: 'replace_flow',
        expected_rev: list.body.rev,
        payload: {
          flowId: 'tab-1',
          flow: {
            id: 'tab-1',
            type: 'tab',
            label: 'Main',
            nodes: [{ id: 'n1', type: 'inject', z: 'tab-1' }],
          },
        },
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      type: 'replace_flow',
      status: 'pending',
      expectedRev: 'rev-1',
      payload: { flowId: 'tab-1' },
      changeSummary: expect.any(String),
      createdBy: { kind: 'access-link', linkId: link.id },
    });

    const mine = await request(app).get('/mcp/api/v1/proposals?mine=true').set(auth);
    expect(mine.status).toBe(200);
    expect(mine.body.proposals).toHaveLength(1);
    expect(mine.body.proposals[0].id).toBe(created.body.id);
    expect(mine.body.proposals[0].mine).toBe(true);

    const got = await request(app).get(`/mcp/api/v1/proposals/${created.body.id}`).set(auth);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(created.body.id);
  });

  it('returns 401 that tells the AI to ask for a new access link', async () => {
    const { app, linkStore } = createApp({ userDir });

    // Shared read with no token: access_link_missing (not passport auth_required).
    const noToken = await request(app).get('/mcp/api/v1/flows');
    expect(noToken.status).toBe(401);
    expect(noToken.body.error).toBe(ACCESS_LINK_MISSING_MESSAGE);
    expect(noToken.body.code).toBe(ACCESS_LINK_MISSING_CODE);
    expect(noToken.headers['www-authenticate']).toBe(ACCESS_LINK_WWW_AUTHENTICATE);

    // Shared read routes: unknown aia_ tokens get access_link_invalid (editor
    // Bearer tokens fall through to admin session instead).
    const bad = await request(app)
      .get('/mcp/api/v1/flows')
      .set('Authorization', 'Bearer aia_not-a-real-token');
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe(ACCESS_LINK_INVALID_MESSAGE);
    expect(bad.body.code).toBe(ACCESS_LINK_INVALID_CODE);
    expect(bad.headers['www-authenticate']).toBe(ACCESS_LINK_WWW_AUTHENTICATE);

    const create = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', 'Bearer aia_expired-or-revoked')
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', flow: { nodes: [] } },
      });
    expect(create.status).toBe(401);
    expect(create.body.error).toBe(ACCESS_LINK_INVALID_MESSAGE);
    expect(create.body.code).toBe(ACCESS_LINK_INVALID_CODE);

    const created = linkStore.create({ kind: 'rest', label: 'temp' });
    linkStore.revoke(created.id);
    const revoked = await request(app)
      .get('/mcp/api/v1/flows')
      .set('Authorization', `Bearer ${created.token}`);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error).toBe(ACCESS_LINK_INVALID_MESSAGE);

    const noBearerCreate = await request(app)
      .post('/mcp/api/v1/proposals')
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', flow: { nodes: [] } },
      });
    expect(noBearerCreate.status).toBe(401);
    expect(noBearerCreate.body.error).toBe(ACCESS_LINK_MISSING_MESSAGE);
    expect(noBearerCreate.body.code).toBe(ACCESS_LINK_MISSING_CODE);
    expect(noBearerCreate.headers['www-authenticate']).toBe(ACCESS_LINK_WWW_AUTHENTICATE);
  });

  it('rejects admin-session create of proposals (access-link only)', async () => {
    const app = express();
    app.use(express.json());
    const userDirLocal = userDir;
    const linkStore = new AccessLinkStore();
    const RED: NodeRedPluginAPI = {
      settings: {
        userDir: userDirLocal,
        httpAdminRoot: '/',
        adminAuth: { type: 'credentials' },
      },
      httpAdmin: app,
      auth: {
        needsPermission() {
          return (req: Request, _res: Response, next: NextFunction) => {
            (req as Request & { user?: MockUser }).user = {
              username: 'admin',
              permissions: '*',
            };
            next();
          };
        },
      },
      plugins: {
        registerPlugin() {
          return undefined;
        },
      },
      log: { info: vi.fn() },
    };
    registerRoutes(RED, {
      linkStore,
      flowAdapter: {
        kind: 'red',
        getFlows: () => Promise.resolve({ rev: 'r', flows: [] }),
        getFlow: () => Promise.resolve({ rev: 'r', flow: { id: 't', type: 'tab' } }),
        updateFlow: () => Promise.resolve({ rev: 'r2' }),
      },
    });

    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .send({
        type: 'replace_flow',
        expectedRev: 'r',
        payload: { flowId: 'tab-1', flow: { nodes: [] } },
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(ACCESS_LINK_MISSING_MESSAGE);
    expect(res.body.code).toBe(ACCESS_LINK_MISSING_CODE);
  });
});
