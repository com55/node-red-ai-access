/**
 * Real-world bug regressions (size limit, expectedRev at submit, auth codes, UX).
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
import { MAX_PROPOSAL_JSON_BYTES, registerRoutes } from '../../src/plugin/index.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import { createFlowAdapter } from '../../src/runtime/create-adapter.js';
import { AdapterUnavailableError, PluginMisconfiguredError } from '../../src/runtime/errors.js';
import { HttpAdapter } from '../../src/runtime/http-adapter.js';
import type { FlowAdapter } from '../../src/runtime/types.js';
import { sanitizeFlowTab } from '../../src/storage/safe.js';
import { StoragePayloadTooLargeError } from '../../src/storage/trusted-write.js';

function createApp(options: { userDir: string; adapter?: FlowAdapter; jsonLimit?: string }): {
  app: Express;
  linkStore: AccessLinkStore;
} {
  const app = express();
  app.use(express.json({ limit: options.jsonLimit ?? '5mb' }));

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
          rev: 'rev-live',
          flows: [{ id: 'tab-1', type: 'tab', label: 'Main' }],
        }),
      getFlow: (id: string) =>
        Promise.resolve({
          rev: 'rev-live',
          flow: { id, type: 'tab', label: 'Main', nodes: [{ id: 'n1', type: 'inject', z: id }] },
        }),
      updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
    } as FlowAdapter);

  registerRoutes(RED, { linkStore, flowAdapter: adapter });
  return { app, linkStore };
}

describe('bugfix: adapter selection (adminAuth)', () => {
  it('refuses unauthenticated HTTP fallback when adminAuth is enabled', () => {
    expect(() =>
      createFlowAdapter({
        RED: {},
        http: { baseUrl: 'http://127.0.0.1:1880' },
        adminAuthEnabled: true,
      })
    ).toThrow(AdapterUnavailableError);
  });

  it('maps HTTP 401 from Admin API to PluginMisconfiguredError', async () => {
    const adapter = new HttpAdapter({
      baseUrl: 'http://127.0.0.1:9',
      fetch: async () =>
        new Response(JSON.stringify({ message: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    await expect(adapter.getFlows()).rejects.toBeInstanceOf(PluginMisconfiguredError);
    await expect(adapter.getFlows()).rejects.toMatchObject({
      code: 'plugin_misconfigured',
      statusCode: 502,
    });
  });
});

describe('bugfix: proposal size + expectedRev + auth codes', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-bugfix-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('sanitizeFlowTab throws 413 instead of dropping oversized nodes', () => {
    const nodes = Array.from({ length: 80 }, (_, i) => ({
      id: `n${i}`,
      type: 'function',
      z: 'tab1',
      func: 'x'.repeat(25_000),
    }));
    expect(() => sanitizeFlowTab({ id: 'tab1', type: 'tab', nodes })).toThrow(
      StoragePayloadTooLargeError
    );
    try {
      sanitizeFlowTab({ id: 'tab1', type: 'tab', nodes });
    } catch (err) {
      expect(err).toMatchObject({ code: 'payload_too_large', statusCode: 413 });
    }
  });

  it('POST /proposals rejects oversized payload with 413 (never stores truncated tab)', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ kind: 'rest', label: 'ai' });
    const bigNodes = Array.from({ length: 40 }, (_, i) => ({
      id: `n${i}`,
      type: 'function',
      z: 'tab-1',
      func: 'y'.repeat(50_000),
    }));
    const payload = {
      flowId: 'tab-1',
      flow: { id: 'tab-1', type: 'tab', label: 'Main', nodes: bigNodes },
    };
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeGreaterThan(
      MAX_PROPOSAL_JSON_BYTES
    );

    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({ type: 'replace_flow', expectedRev: 'rev-live', payload });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('payload_too_large');
    expect(res.body.error).toMatch(/limit/i);

    const listed = await request(app)
      .get('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`);
    expect(listed.body.proposals).toHaveLength(0);
  });

  it('rejects stale expectedRev at submit time with 409', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ kind: 'rest', label: 'ai' });

    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'stale123',
        payload: {
          flowId: 'tab-1',
          flow: { id: 'tab-1', type: 'tab', label: 'Main', nodes: [{ id: 'n1', type: 'inject' }] },
        },
      });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'version_mismatch',
      expectedRev: 'stale123',
      currentRev: 'rev-live',
    });
    expect(res.body.error).toMatch(/expectedRev/);
  });

  it('accepts expected_rev as alias for expectedRev when rev matches', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ kind: 'rest', label: 'ai' });

    const res = await request(app)
      .post('/mcp/api/v1/proposals?include=payload')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expected_rev: 'rev-live',
        payload: {
          flowId: 'tab-1',
          flow: { id: 'tab-1', type: 'tab', label: 'Main', nodes: [{ id: 'n1', type: 'inject' }] },
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.expectedRev).toBe('rev-live');
    expect(res.body.payload.flow.nodes).toHaveLength(1);
  });

  it('distinguishes missing vs invalid access-link tokens with codes + WWW-Authenticate', async () => {
    const { app } = createApp({ userDir });

    const missing = await request(app).post('/mcp/api/v1/proposals').send({});
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({
      error: ACCESS_LINK_MISSING_MESSAGE,
      code: ACCESS_LINK_MISSING_CODE,
    });
    expect(missing.headers['www-authenticate']).toBe(ACCESS_LINK_WWW_AUTHENTICATE);

    // Shared read: unknown aia_ tokens → access_link_invalid; other Bearer
    // (editor session) falls through to admin auth instead.
    const invalid = await request(app)
      .get('/mcp/api/v1/flows')
      .set('Authorization', 'Bearer aia_not-real');
    expect(invalid.status).toBe(401);
    expect(invalid.body).toMatchObject({
      error: ACCESS_LINK_INVALID_MESSAGE,
      code: ACCESS_LINK_INVALID_CODE,
    });
    expect(String(invalid.body.hint ?? '')).toMatch(/truncated/i);
    expect(invalid.headers['www-authenticate']).toBe(ACCESS_LINK_WWW_AUTHENTICATE);
  });

  it('get_status /status reports permission:null and caller.access-link for AI tokens', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ kind: 'rest', label: 'claude' });

    const status = await request(app)
      .get('/mcp/api/v1/status')
      .set('Authorization', `Bearer ${link.token}`);
    expect(status.status).toBe(200);
    expect(status.body.permission).toBeNull();
    expect(status.body.caller).toMatchObject({
      kind: 'access-link',
      linkId: link.id,
      label: 'claude',
    });
    expect(status.body.caller.expiresAt).toBeTruthy();
    expect(status.body.caller.permissions).toContain('flows:read');
    expect(status.body.caller.baseUrls.api).toBe('/mcp/api/v1');

    const flows = await request(app)
      .get('/mcp/api/v1/flows')
      .set('Authorization', `Bearer ${link.token}`);
    expect(flows.status).toBe(200);
    expect(flows.body.rev).toBe('rev-live');
  });
});

describe('bugfix: /mcp public shell', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-mcp-shell-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('serves GET /mcp without admin auth (boot shell + localStorage Bearer design)', async () => {
    const { app } = createApp({ userDir });
    const res = await request(app).get('/mcp');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toMatch(/data-config=/);
    expect(res.text).toMatch(/authTokenKey/);
    expect(res.text).toMatch(/auth-tokens/);
    expect(res.text).toMatch(/localStorage/);
    expect(res.text).toMatch(/Authorization/);
    expect(res.text).toMatch(/Bearer/);
    expect(res.text).toMatch(/showAuthGate|Please sign in to Node-RED first|auth-gate/i);
  });
});
