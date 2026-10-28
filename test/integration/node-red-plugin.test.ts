/**
 * In-process Node-RED 4.x + adminAuth integration.
 *
 * Uses createNodeApi-style RED (`runtime.adminApp`, no `.runtime`) while
 * requests hit the parent editor-api app (body-parser). Verifies adapter
 * selection, malformed JSON → JSON/JSON-RPC (not HTML), API 401 JSON, and
 * replace_flow approve (setFlows shape) for deploymentType nodes|flows|full.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('Node-RED 4/5 in-process plugin integration', { timeout: 30_000 }, () => {
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
        maxActiveLinks: 20,
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

    // Wait until in-process flows API is ready (activeConfig can be null briefly
    // after start under CI load, which made early list_flows return 502).
    const runtimeFlows = (
      requireCjs('@node-red/runtime') as {
        flows: { getFlows: (opts?: object) => Promise<unknown> };
      }
    ).flows;
    const readyDeadline = Date.now() + 30_000;
    for (;;) {
      const snapshot = await runtimeFlows.getFlows({});
      if (
        snapshot &&
        typeof snapshot === 'object' &&
        !Array.isArray(snapshot) &&
        typeof (snapshot as { rev?: unknown }).rev === 'string' &&
        Array.isArray((snapshot as { flows?: unknown }).flows)
      ) {
        break;
      }
      if (Date.now() > readyDeadline) {
        throw new Error(`Node-RED flows API not ready: ${JSON.stringify(snapshot)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

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

    linkStore = new AccessLinkStore({ maxActiveLinks: 20 });
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

  it('GET /mcp is public; unauthenticated /status returns JSON access_link_missing', async () => {
    const page = await request(RED.httpAdmin).get('/ai-access');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/localStorage/);

    const statusUnauth = await request(RED.httpAdmin).get('/mcp/api/v1/status');
    expect(statusUnauth.status).toBe(401);
    expect(statusUnauth.headers['content-type']).toMatch(/json/);
    expect(statusUnauth.body.code).toBe('access_link_missing');
    expect(String(statusUnauth.body.error)).toMatch(/access link/i);
    expect(statusUnauth.headers['www-authenticate']).toMatch(/Bearer/);
    expect(String(statusUnauth.headers['www-authenticate'] ?? '')).not.toMatch(/Users/);
    expect(statusUnauth.text).not.toBe('Unauthorized');

    const statusAuth = await request(RED.httpAdmin)
      .get('/mcp/api/v1/status')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(statusAuth.status).toBe(200);
    expect(statusAuth.body.aiFeaturesEnabled).toBe(true);
  });

  it('list_flows via access link uses in-process runtime (not 502 Unauthorized)', async () => {
    const link = linkStore.create({ kind: 'rest', label: 'integration' });
    const flows = await request(RED.httpAdmin)
      .get('/mcp/api/v1/flows')
      .set('Authorization', `Bearer ${link.token}`);
    expect(flows.status).toBe(200);
    expect(typeof flows.body.rev).toBe('string');
    expect(flows.body.flows.some((n: { id?: string }) => n.id === 'tab1')).toBe(true);
  });

  it('rejects stale expectedRev at submit', async () => {
    const link = linkStore.create({ kind: 'rest', label: 'submit-tests' });
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
    const link = linkStore.create({ kind: 'mcp', label: 'parse-rpc' });
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
    const link = linkStore.create({ kind: 'rest', label: 'parse-rest' });

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

  it('get_flow includes type:tab even when Node-RED omits type', async () => {
    const link = linkStore.create({ kind: 'rest', label: 'get-flow-type' });
    const res = await request(RED.httpAdmin)
      .get('/mcp/api/v1/flows/tab1')
      .set('Authorization', `Bearer ${link.token}`);
    expect(res.status).toBe(200);
    expect(res.body.flow).toMatchObject({ id: 'tab1', type: 'tab' });
    expect(Array.isArray(res.body.flow.nodes)).toBe(true);
    expect(typeof res.body.rev).toBe('string');
  });

  it('GET /flows missing/invalid token returns access_link_* (not Users realm)', async () => {
    const missing = await request(RED.httpAdmin).get('/mcp/api/v1/flows');
    expect(missing.status).toBe(401);
    expect(missing.headers['content-type']).toMatch(/json/);
    expect(missing.body.code).toBe('access_link_missing');
    expect(String(missing.body.error)).toMatch(/ask the user for a new access link/i);
    expect(missing.headers['www-authenticate']).toMatch(/Bearer/);
    expect(missing.headers['www-authenticate'] ?? '').not.toMatch(/Users/);
    expect(missing.text).not.toBe('Unauthorized');

    const invalid = await request(RED.httpAdmin)
      .get('/mcp/api/v1/flows')
      .set('Authorization', 'Bearer aia_not-a-real-token');
    expect(invalid.status).toBe(401);
    expect(invalid.body.code).toBe('access_link_invalid');
    expect(invalid.headers['www-authenticate']).toMatch(/Bearer/);
    expect(invalid.headers['www-authenticate'] ?? '').not.toMatch(/Users/);
  });

  it('GET /status accepts access-link Bearer with caller info', async () => {
    const link = linkStore.create({ kind: 'rest', label: 'status-link', ttlSeconds: 7200 });
    const res = await request(RED.httpAdmin)
      .get('/mcp/api/v1/status')
      .set('Authorization', `Bearer ${link.token}`);
    expect(res.status).toBe(200);
    expect(res.body.permission).toBeNull();
    expect(res.body.caller).toMatchObject({
      kind: 'access-link',
      linkId: link.id,
      label: 'status-link',
      tokenKind: 'rest',
    });
    expect(typeof res.body.caller.expiresAt).toBe('string');
    expect(Array.isArray(res.body.caller.permissions)).toBe(true);
    expect(res.body.caller.baseUrls).toEqual({
      api: '/mcp/api/v1',
      openapi: '/mcp/api/v1/openapi.yaml',
      openapiJson: '/mcp/api/v1/openapi.json',
      discovery: '/mcp/api/v1',
    });
  });

  it('discovery index and unknown /mcp/api/v1 routes are JSON', async () => {
    const index = await request(RED.httpAdmin).get('/mcp/api/v1');
    expect(index.status).toBe(200);
    expect(index.body.ok).toBe(true);
    expect(index.body.auth.header).toBe('Authorization: Bearer <token>');
    expect(index.body.openapi).toBe('/mcp/api/v1/openapi.yaml');
    expect(index.body.mcp).toBe('/mcp/rpc');

    const missing = await request(RED.httpAdmin).get('/mcp/api/v1/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toMatch(/json/);
    expect(missing.body).toEqual({ error: 'Not found', code: 'not_found' });
    expect(missing.text).not.toMatch(/Cannot GET|<html/i);
  });

  it('GET /mcp/a/<token> docs, flows, propose, and chunked HTML draft (adminAuth on)', async () => {
    const { createHash } = await import('node:crypto');
    // Free a slot if the shared in-memory store is at capacity from earlier tests.
    for (const existing of linkStore.list()) {
      if (linkStore.list().length < 10) break;
      linkStore.revoke(existing.id);
    }
    const created = await request(RED.httpAdmin)
      .post('/mcp/api/v1/links')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Host', '127.0.0.1')
      .send({ label: 'get-link-int' });
    expect(created.status).toBe(201);
    expect(created.body.url).toMatch(/\/mcp\/a\/aia_/);
    const token = created.body.token as string;

    const docs = await request(RED.httpAdmin).get(`/mcp/a/${token}`);
    expect(docs.status).toBe(200);
    expect(docs.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(docs.headers['cache-control']).toMatch(/no-store/);
    expect(docs.text).toMatch(/pending proposal/i);

    const flows = await request(RED.httpAdmin).get(`/mcp/a/${token}/flows`);
    expect(flows.status).toBe(200);
    expect(typeof flows.body.rev).toBe('string');
    const rev = flows.body.rev as string;

    const one = await request(RED.httpAdmin).get(`/mcp/a/${token}/flows/tab1`);
    expect(one.status).toBe(200);
    expect(one.body.flow).toMatchObject({ id: 'tab1', type: 'tab' });

    const proposed = await request(RED.httpAdmin).get(
      `/mcp/a/${token}/propose?flow=tab1&rev=${encodeURIComponent(rev)}&node=n1&set.name=ViaGet`
    );
    expect(proposed.status).toBe(201);
    expect(proposed.body.proposal.status).toBe('pending');

    const html = `<html><body>${'x'.repeat(500)}<h1>chunked</h1></body></html>`;
    const htmlBuf = Buffer.from(html, 'utf8');
    const sha256 = createHash('sha256').update(htmlBuf).digest('hex');
    const draft = await request(RED.httpAdmin).get(
      `/mcp/a/${token}/draft/new?flow=tab1&rev=${encodeURIComponent(rev)}&node=n1&field=name`
    );
    expect(draft.status).toBe(201);
    const draftId = draft.body.draftId as string;
    const mid = Math.ceil(htmlBuf.length / 2);
    const parts = [htmlBuf.subarray(0, mid), htmlBuf.subarray(mid)];
    for (let seq = 0; seq < parts.length; seq += 1) {
      const data = parts[seq]!.toString('base64url');
      const append = await request(RED.httpAdmin).get(
        `/mcp/a/${token}/draft/${draftId}/append?seq=${seq}&data=${data}`
      );
      expect(append.status).toBe(200);
    }
    const submitted = await request(RED.httpAdmin).get(
      `/mcp/a/${token}/draft/${draftId}/submit?sha256=${sha256}&include=payload`
    );
    expect(submitted.status).toBe(201);
    expect(submitted.body.proposal.status).toBe('pending');
    expect(
      submitted.body.proposal.payload.flow.nodes.find((n: { id: string }) => n.id === 'n1').name
    ).toBe(html);

    linkStore.revoke(created.body.id);
  });

  it('admin editor Bearer works on status/links/logs/proposals (page routes)', async () => {
    // Same token shape the /mcp page reads from editor localStorage.
    const auth = { Authorization: `Bearer ${adminToken}` };

    const status = await request(RED.httpAdmin).get('/mcp/api/v1/status').set(auth);
    expect(status.status).toBe(200);
    expect(status.body.aiFeaturesEnabled).toBe(true);

    const links = await request(RED.httpAdmin).get('/mcp/api/v1/links').set(auth);
    expect(links.status).toBe(200);
    expect(Array.isArray(links.body.links)).toBe(true);

    const logs = await request(RED.httpAdmin).get('/mcp/api/v1/logs?limit=100').set(auth);
    expect(logs.status).toBe(200);
    expect(Array.isArray(logs.body.logs)).toBe(true);

    // Regression: editor Bearer was mis-classified as an access-link token → 401.
    const proposals = await request(RED.httpAdmin).get('/mcp/api/v1/proposals').set(auth);
    expect(proposals.status).toBe(200);
    expect(Array.isArray(proposals.body.proposals)).toBe(true);
    expect(proposals.body.code).not.toBe('access_link_invalid');
  });

  it('GET/PUT /settings: * can persist; changes apply without restart', async () => {
    const auth = { Authorization: `Bearer ${adminToken}` };

    const got = await request(RED.httpAdmin).get('/mcp/api/v1/settings').set(auth);
    expect(got.status).toBe(200);
    expect(got.body.canEdit).toBe(true);
    expect(got.body.adminAuthEnabled).toBe(true);
    expect(got.body.settings.enabled).toBe(true);
    expect(got.body.precedence[0]).toBe('settings.js');

    const put = await request(RED.httpAdmin).put('/mcp/api/v1/settings').set(auth).send({
      defaultDeploymentType: 'full',
      defaultLinkTtlSeconds: 7200,
    });
    expect(put.status).toBe(200);
    expect(put.body.settings.defaultDeploymentType).toBe('nodes');
    expect(put.body.settings.defaultLinkTtlSeconds).toBe(7200);
    expect(put.body.sources.defaultDeploymentType).toBe('settings.js');

    const settingsFile = join(userDir, '.ai-access', 'config.json');
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({
      defaultLinkTtlSeconds: 7200,
    });

    const status = await request(RED.httpAdmin).get('/mcp/api/v1/status').set(auth);
    expect(status.status).toBe(200);
    expect(status.body.defaultDeploymentType).toBe('nodes');
    expect(status.body.defaultLinkTtlSeconds).toBe(7200);
    expect(status.body.aiAccessEnabled).toBe(true);
  });

  it.each(['nodes', 'flows', 'full'] as const)(
    'approve replace_flow with deploymentType=%s deploys nested get_flow shape',
    async deploymentType => {
      const link = linkStore.create({ kind: 'rest', label: `approve-${deploymentType}` });

      const snapshot = await request(RED.httpAdmin)
        .get('/mcp/api/v1/flows/tab1')
        .set('Authorization', `Bearer ${link.token}`);
      expect(snapshot.status).toBe(200);
      const rev = snapshot.body.rev as string;
      expect(rev.length).toBeGreaterThan(0);

      // Exact nested get_flow shape from the real-world blocker: no `type`, no `configs`.
      const label = `Test Flow ${deploymentType}`;
      const nestedFlow = {
        id: 'tab1',
        label,
        nodes: [
          {
            id: `inj-${deploymentType}`,
            type: 'inject',
            z: 'tab1',
            name: '',
            props: [],
            once: false,
            x: 120,
            y: 120,
            wires: [[`fn-${deploymentType}`]],
          },
          {
            id: `fn-${deploymentType}`,
            type: 'function',
            z: 'tab1',
            name: 'pass',
            func: 'return msg;',
            outputs: 1,
            x: 300,
            y: 120,
            wires: [[`dbg-${deploymentType}`]],
          },
          {
            id: `dbg-${deploymentType}`,
            type: 'debug',
            z: 'tab1',
            name: 'out',
            x: 480,
            y: 120,
            // debug has 0 outputs — wires must be []
            wires: [],
          },
        ],
      };

      const created = await request(RED.httpAdmin)
        .post('/mcp/api/v1/proposals')
        .set('Authorization', `Bearer ${link.token}`)
        .send({
          type: 'replace_flow',
          expectedRev: rev,
          payload: { flowId: 'tab1', flow: nestedFlow },
        });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('pending');

      const approved = await request(RED.httpAdmin)
        .post(`/mcp/api/v1/proposals/${created.body.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(deploymentType === 'nodes' ? {} : { deploymentType });
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('approved');
      expect(approved.body.reason).toBeUndefined();
      expect(typeof approved.body.resultRev).toBe('string');
      expect(approved.body.resultRev).not.toBe(rev);

      const flowsOnDisk = JSON.parse(readFileSync(join(userDir, 'flows.json'), 'utf8')) as {
        id?: string;
        type?: string;
        label?: string;
        z?: string;
      }[];
      expect(flowsOnDisk.find(n => n.id === 'tab1')).toMatchObject({
        type: 'tab',
        label,
      });
      expect(flowsOnDisk.some(n => n.id === `inj-${deploymentType}` && n.z === 'tab1')).toBe(true);
      expect(flowsOnDisk.some(n => n.id === `fn-${deploymentType}` && n.z === 'tab1')).toBe(true);
      expect(flowsOnDisk.some(n => n.id === `dbg-${deploymentType}` && n.z === 'tab1')).toBe(true);

      const after = await request(RED.httpAdmin)
        .get('/mcp/api/v1/flows/tab1')
        .set('Authorization', `Bearer ${link.token}`);
      expect(after.status).toBe(200);
      expect(after.body.rev).toBe(approved.body.resultRev);
      expect(after.body.flow).toMatchObject({ id: 'tab1', type: 'tab', label });
      expect(after.body.flow.nodes.map((n: { id: string }) => n.id).sort()).toEqual(
        [`dbg-${deploymentType}`, `fn-${deploymentType}`, `inj-${deploymentType}`].sort()
      );
    }
  );

  async function editorSnapshot() {
    const result = await request(RED.httpAdmin)
      .get('/flows')
      .set('Node-RED-API-Version', 'v2')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(result.status).toBe(200);
    return result.body as { rev: string; flows: Record<string, unknown>[] };
  }

  async function editorDeploy(snapshot: { rev: string; flows: Record<string, unknown>[] }) {
    const result = await request(RED.httpAdmin)
      .post('/flows')
      .set('Node-RED-API-Version', 'v2')
      .set('Node-RED-Deployment-Type', 'nodes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(snapshot);
    expect(result.status).toBe(200);
    return result.body as { rev: string };
  }

  it('keeps Flow 3 and Flow 4 proposals pending after creating Flow Test MCP AI Access, then approves both', async () => {
    const link = linkStore.create({ kind: 'rest', label: 'owner-exact-case' });
    const auth = { Authorization: `Bearer ${link.token}` };
    const initial = await editorSnapshot();
    await editorDeploy({
      rev: initial.rev,
      flows: [
        ...initial.flows,
        ...[3, 4].flatMap(i => [
          { id: `flow-${i}`, type: 'tab', label: `Flow ${i}` },
          {
            id: `node-${i}`,
            type: 'function',
            z: `flow-${i}`,
            name: `original ${i}`,
            func: 'return msg;',
            outputs: 1,
            x: 100,
            y: 100,
            wires: [[]],
          },
        ]),
      ],
    });
    const candidates: { id: string; flowId: string; nodeId: string; name: string }[] = [];
    for (const i of [3, 4]) {
      const snap = await request(RED.httpAdmin).get(`/mcp/api/v1/flows/flow-${i}`).set(auth);
      expect(snap.status).toBe(200);
      const name = `AI change ${i}`;
      const submitted = await request(RED.httpAdmin)
        .post('/mcp/api/v1/proposals')
        .set(auth)
        .send({
          type: 'replace_flow',
          expectedRev: snap.body.rev,
          payload: {
            flowId: `flow-${i}`,
            flow: {
              ...snap.body.flow,
              nodes: snap.body.flow.nodes.map((n: { id: string }) =>
                n.id === `node-${i}` ? { ...n, name } : n
              ),
            },
          },
        });
      expect(submitted.status).toBe(201);
      expect(submitted.body.status).toBe('pending');
      candidates.push({ id: submitted.body.id, flowId: `flow-${i}`, nodeId: `node-${i}`, name });
    }
    const beforeNewTab = await editorSnapshot();
    const newTab = {
      id: 'flow-test-mcp-ai-access',
      type: 'tab',
      label: 'Flow Test MCP AI Access',
      info: 'Keep this editor tab intact',
      env: [{ name: 'MODE', value: 'test', type: 'str' }],
    };
    const moved = await editorDeploy({
      rev: beforeNewTab.rev,
      flows: [...beforeNewTab.flows, newTab],
    });
    expect(moved.rev).not.toBe(beforeNewTab.rev);
    const listed = await request(RED.httpAdmin).get('/mcp/api/v1/proposals').set(auth);
    expect(listed.status).toBe(200);
    for (const candidate of candidates) {
      expect(
        listed.body.proposals.find((p: { id: string }) => p.id === candidate.id)
      ).toMatchObject({ status: 'pending', rebase: { state: 'clean', rev: moved.rev } });
    }
    for (const candidate of candidates) {
      const approved = await request(RED.httpAdmin)
        .post(`/mcp/api/v1/proposals/${candidate.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('approved');
    }
    const final = await editorSnapshot();
    expect(final.flows.find(n => n.id === newTab.id)).toEqual(newTab);
    for (const candidate of candidates) {
      expect(final.flows.find(n => n.id === candidate.nodeId)).toMatchObject({
        z: candidate.flowId,
        name: candidate.name,
      });
      const decided = await request(RED.httpAdmin)
        .get(`/mcp/api/v1/proposals/${candidate.id}`)
        .set(auth);
      expect(decided.body.status).toBe('approved');
    }
  });

  it('reports a conflict and blocks approve when the editor edits the same node', async () => {
    const link = linkStore.create({ kind: 'rest', label: 'same-node-conflict' });
    const auth = { Authorization: `Bearer ${link.token}` };
    const snap = await request(RED.httpAdmin).get('/mcp/api/v1/flows/flow-3').set(auth);
    expect(snap.status).toBe(200);
    const submitted = await request(RED.httpAdmin)
      .post('/mcp/api/v1/proposals')
      .set(auth)
      .send({
        type: 'replace_flow',
        expectedRev: snap.body.rev,
        payload: {
          flowId: 'flow-3',
          nodes: [{ op: 'set', id: 'node-3', set: { name: 'AI pending change' } }],
        },
      });
    expect(submitted.status).toBe(201);
    const live = await editorSnapshot();
    await editorDeploy({
      rev: live.rev,
      flows: live.flows.map(n => (n.id === 'node-3' ? { ...n, name: 'Editor change wins' } : n)),
    });
    const listed = await request(RED.httpAdmin).get('/mcp/api/v1/proposals').set(auth);
    expect(
      listed.body.proposals.find((p: { id: string }) => p.id === submitted.body.id)
    ).toMatchObject({
      status: 'conflict',
      rebase: {
        state: 'conflict',
        conflicts: [expect.objectContaining({ kind: 'node_changed_both', nodeId: 'node-3' })],
      },
    });
    const blocked = await request(RED.httpAdmin)
      .post(`/mcp/api/v1/proposals/${submitted.body.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({
      code: 'proposal_conflict',
      conflicts: [expect.objectContaining({ nodeId: 'node-3' })],
    });
    const final = await editorSnapshot();
    expect(final.flows.find(n => n.id === 'node-3')!.name).toBe('Editor change wins');
    const pending = await request(RED.httpAdmin)
      .get(`/mcp/api/v1/proposals/${submitted.body.id}`)
      .set(auth);
    expect(pending.body.status).toBe('conflict');
  });
});
