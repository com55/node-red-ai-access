/**
 * In-process Node-RED 4.x + adminAuth integration.
 *
 * Uses createNodeApi-style RED (`runtime.adminApp`, no `.runtime`) while
 * requests hit the parent editor-api app (body-parser). Verifies adapter
 * selection, malformed JSON → JSON/JSON-RPC (not HTML), and API 401 JSON.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import { createFlowAdapter } from '../../src/runtime/create-adapter.js';

const requireCjs = createRequire(import.meta.url);

interface NodeRedEmbed {
  init: (server: Server, settings: Record<string, unknown>) => void;
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  httpAdmin: import('express').Express;
  auth: NodeRedPluginAPI['auth'];
  settings: NodeRedPluginAPI['settings'] & Record<string, unknown>;
  runtime?: unknown;
  log?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

describe('Node-RED 4.x in-process plugin integration', () => {
  let userDir: string;
  let server: Server;
  let RED: NodeRedEmbed;
  let runtimeHttpAdmin: import('express').Express;
  let port: number;
  let linkStore: AccessLinkStore;
  let adminToken: string;

  beforeAll(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'nr-ai-access-int-'));
    mkdirSync(join(userDir, 'lib', 'flows'), { recursive: true });
    writeFileSync(
      join(userDir, 'flows.json'),
      JSON.stringify([
        { id: 'tab1', type: 'tab', label: 'Flow 1' },
        {
          id: 'n1',
          type: 'inject',
          z: 'tab1',
          name: '',
          props: [],
          once: false,
          x: 100,
          y: 100,
          wires: [[]],
        },
      ])
    );

    const settings = {
      httpAdminRoot: '/',
      httpNodeRoot: '/api',
      userDir,
      flowFile: 'flows.json',
      functionGlobalContext: {},
      logging: { console: { level: 'off', metrics: false, audit: false } },
      editorTheme: { tours: false },
      adminAuth: {
        type: 'credentials',
        users: [
          {
            username: 'admin',
            password: 'placeholder',
            permissions: '*',
          },
        ],
      },
      aiAccess: {
        defaultDeploymentType: 'nodes',
      },
      disableEditor: false,
      SKIP_BUILD_CHECK: true,
    };

    const bcrypt = requireCjs('bcryptjs') as {
      hashSync: (s: string, n: number) => string;
    };
    (settings.adminAuth as { users: { password: string }[] }).users[0]!.password = bcrypt.hashSync(
      'password',
      8
    );

    RED = requireCjs('node-red') as NodeRedEmbed;
    const runtime = requireCjs('@node-red/runtime') as {
      httpAdmin: import('express').Express;
    };
    server = createServer((req, res) => {
      RED.httpAdmin(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('no port');
    }
    port = addr.port;
    (settings as { uiPort?: number }).uiPort = port;

    RED.init(server, settings);
    await RED.start();

    runtimeHttpAdmin = runtime.httpAdmin;
    expect(runtimeHttpAdmin).not.toBe(RED.httpAdmin);

    // createNodeApi-style RED: nested runtime.adminApp, no .runtime
    const pluginRED: NodeRedPluginAPI = {
      settings: {
        userDir,
        httpAdminRoot: '/',
        adminAuth: settings.adminAuth,
        aiAccess: settings.aiAccess,
        ...({ uiPort: port } as object),
      } as NodeRedPluginAPI['settings'],
      httpAdmin: runtimeHttpAdmin,
      auth: RED.auth,
      plugins: {
        registerPlugin() {
          return undefined;
        },
      },
      log: {
        info(_message: string) {
          return undefined;
        },
        warn(_message: string) {
          return undefined;
        },
        error(_message: string) {
          return undefined;
        },
      },
    };

    linkStore = new AccessLinkStore({ maxActiveLinks: 10 });
    registerRoutes(pluginRED, { linkStore });

    const tokenRes = await request(RED.httpAdmin).post('/auth/token').type('form').send({
      client_id: 'node-red-admin',
      grant_type: 'password',
      scope: '*',
      username: 'admin',
      password: 'password',
    });
    if (tokenRes.status !== 200 || !tokenRes.body?.access_token) {
      throw new Error(
        `Failed to obtain admin token: ${tokenRes.status} ${JSON.stringify(tokenRes.body)}`
      );
    }
    adminToken = tokenRes.body.access_token as string;
  }, 120_000);

  afterAll(async () => {
    try {
      await RED?.stop?.();
    } catch {
      // ignore
    }
    await new Promise<void>(resolve => {
      server?.close(() => resolve());
    });
    rmSync(userDir, { recursive: true, force: true });
  }, 60_000);

  it('createFlowAdapter uses RedAdapter when plugin RED has no .runtime', () => {
    const adapter = createFlowAdapter({
      RED: {},
      http: { baseUrl: `http://127.0.0.1:${port}` },
      adminAuthEnabled: true,
    });
    expect(adapter.kind).toBe('red');
  });

  it('GET /mcp is public; unauthenticated /status returns JSON auth_required', async () => {
    const page = await request(RED.httpAdmin).get('/mcp');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/localStorage/);

    const statusUnauth = await request(RED.httpAdmin).get('/mcp/api/v1/status');
    expect(statusUnauth.status).toBe(401);
    expect(statusUnauth.headers['content-type']).toMatch(/json/);
    expect(statusUnauth.body).toEqual({
      error: 'Authentication required',
      code: 'auth_required',
    });
    expect(statusUnauth.text).not.toBe('Unauthorized');

    const statusAuth = await request(RED.httpAdmin)
      .get('/mcp/api/v1/status')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(statusAuth.status).toBe(200);
    expect(statusAuth.body.aiFeaturesEnabled).toBe(true);
  });

  it('list_flows via access link uses in-process runtime (not 502 Unauthorized)', async () => {
    const link = linkStore.create({ label: 'integration' });
    const flows = await request(RED.httpAdmin)
      .get('/mcp/api/v1/flows')
      .set('Authorization', `Bearer ${link.token}`);
    expect(flows.status).toBe(200);
    expect(typeof flows.body.rev).toBe('string');
    expect(flows.body.flows.some((n: { id?: string }) => n.id === 'tab1')).toBe(true);
  });

  it('rejects stale expectedRev at submit', async () => {
    const link = linkStore.create({ label: 'submit-tests' });
    const stale = await request(RED.httpAdmin)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'stale123',
        payload: {
          flowId: 'tab1',
          flow: {
            id: 'tab1',
            type: 'tab',
            label: 'Flow 1',
            nodes: [{ id: 'n1', type: 'inject', z: 'tab1' }],
          },
        },
      });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_mismatch');
  });

  it('malformed JSON on /mcp/rpc returns JSON-RPC -32700 (not HTML from body-parser)', async () => {
    const link = linkStore.create({ label: 'parse-rpc' });
    const res = await request(RED.httpAdmin)
      .post('/mcp/rpc')
      .set('Authorization', `Bearer ${link.token}`)
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
    expect(res.text).not.toMatch(/<!DOCTYPE|<html|SyntaxError|body-parser/i);
  });

  it('malformed JSON on REST /proposals and /links returns invalid_json (not HTML)', async () => {
    const link = linkStore.create({ label: 'parse-rest' });

    const proposals = await request(RED.httpAdmin)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(proposals.status).toBe(400);
    expect(proposals.headers['content-type']).toMatch(/json/);
    expect(proposals.body).toEqual({ error: 'Invalid JSON body', code: 'invalid_json' });
    expect(proposals.text).not.toMatch(/<!DOCTYPE|<html|SyntaxError|body-parser/i);

    const links = await request(RED.httpAdmin)
      .post('/mcp/api/v1/links')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(links.status).toBe(400);
    expect(links.headers['content-type']).toMatch(/json/);
    expect(links.body).toEqual({ error: 'Invalid JSON body', code: 'invalid_json' });
    expect(links.text).not.toMatch(/<!DOCTYPE|<html|SyntaxError|body-parser/i);
  });
});
