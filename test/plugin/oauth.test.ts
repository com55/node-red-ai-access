import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import {
  canonicalResource,
  detectOAuthRouteCollisions,
  findHttpInCollisions,
  scanOAuthRouteCollisions,
  type FlowNodeLike,
} from '../../src/plugin/oauth.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter } from '../../src/runtime/types.js';

const issuer = 'https://node.example';
const resource = `${issuer}/mcp`;
const verifier = 'a'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const adapter: FlowAdapter = {
  kind: 'red',
  getFlows: async () => ({ rev: 'r1', flows: [] }),
  getFlow: async () => ({ rev: 'r1', flow: { id: 'flow', type: 'tab', nodes: [] } }),
  updateFlow: async () => ({ rev: 'r2' }),
};

function appFor(
  userDir: string,
  options: {
    fallback?: boolean;
    cap?: number;
    accessTtl?: number;
    refreshTtl?: number;
    collision?: boolean;
    session?: boolean;
    publicUrl?: string;
    enabled?: boolean;
    refreshMax?: number;
    oauthFromDisk?: boolean;
    flowNodes?: FlowNodeLike[];
    httpStatic?: string;
  } = {}
) {
  const admin = express();
  admin.use(express.json());
  const node = options.fallback ? undefined : express();
  if (options.collision) admin.get('/mcp/oauth/token', (_req, res) => res.send('existing'));
  const events = new EventEmitter();
  const RED: NodeRedPluginAPI = {
    settings: {
      userDir,
      httpNodeRoot: options.fallback ? false : '/',
      ...(options.httpStatic ? { httpStatic: options.httpStatic } : {}),
      ...(options.session ? { adminAuth: { type: 'credentials' } } : {}),
      aiAccess: {
        ...(options.enabled === false ? { enabled: false } : {}),
        allowWithoutAdminAuth: true,
        publicBaseUrl: options.publicUrl ?? issuer,
        ...(options.oauthFromDisk
          ? {}
          : {
              oauth: {
                enabled: true,
                dcrMaxClients: options.cap ?? 20,
                accessTokenTtlSec: options.accessTtl ?? 3600,
                refreshIdleTtlSec: options.refreshTtl ?? 2_592_000,
                ...(options.refreshMax !== undefined
                  ? { refreshMaxLifetimeSec: options.refreshMax }
                  : {}),
              },
            }),
      },
    },
    httpAdmin: admin,
    ...(node ? { httpNode: node } : {}),
    events,
    ...(options.flowNodes
      ? { nodes: { eachNode: fn => options.flowNodes?.forEach(n => fn(n)) } }
      : {}),
    auth: {
      needsPermission: () => (req, res, next) => {
        const who = req.headers['x-test-user'];
        if (options.session && who !== 'alice' && who !== 'bob') {
          res.status(401).end();
          return;
        }
        if (options.session)
          Object.assign(req, {
            user:
              who === 'bob'
                ? { username: 'bob@example.com', permissions: 'read' }
                : { username: 'alice@example.com', permissions: '*' },
          });
        next();
      },
    },
    plugins: { registerPlugin: () => undefined },
  };
  const linkStore = new AccessLinkStore({ maxActiveLinks: 10 });
  registerRoutes(RED, { flowAdapter: adapter, linkStore });
  return { admin, node, linkStore, events };
}
async function register(app: Express, redirect = 'http://127.0.0.1:3456/callback') {
  return request(app)
    .post('/mcp/oauth/register')
    .send({
      client_name: 'Test client',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
    });
}
function consentParams(
  clientId: string,
  resourceUrl = resource,
  method = 'S256',
  scope = 'read propose'
) {
  return {
    client_id: clientId,
    redirect_uri: 'http://127.0.0.1:3456/callback',
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: method,
    scope,
    resource: resourceUrl,
    state: 'abc',
  };
}
/** Drives the consent shell the way its browser script does. */
async function approve(app: Express, page: request.Response, user?: string, decision = 'allow') {
  const id = /data-request="([^"]+)"/.exec(page.text)![1]!;
  const auth = (r: request.Test) => (user ? r.set('x-test-user', user) : r);
  const details = await auth(request(app).get(`/mcp/oauth/consent/${id}`));
  if (details.status !== 200) return { details };
  const granted = await auth(request(app).post(`/mcp/oauth/consent/${id}`))
    .set('Sec-Fetch-Site', 'same-origin')
    .send({ csrf: details.body.csrf, decision });
  const location = granted.body.redirect as string | undefined;
  return {
    id,
    details,
    granted,
    code: location ? new URL(location).searchParams.get('code') : null,
  };
}
async function authorize(
  app: Express,
  clientId: string,
  resourceUrl = resource,
  method = 'S256',
  scope = 'read propose',
  user?: string
) {
  const page = await request(app)
    .get('/mcp/oauth/authorize')
    .query(consentParams(clientId, resourceUrl, method, scope));
  if (page.status !== 200) return { page };
  return { page, ...(await approve(app, page, user)) };
}
async function exchange(
  app: Express,
  clientId: string,
  code: string,
  resourceUrl = resource,
  codeVerifier = verifier
) {
  return request(app).post('/mcp/oauth/token').type('form').send({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: 'http://127.0.0.1:3456/callback',
    resource: resourceUrl,
  });
}
async function callTool(
  app: Express,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
) {
  const response = await request(app)
    .post('/mcp/rpc')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const content = response.body.result?.content as { text: string }[] | undefined;
  return {
    response,
    value: content?.[0] ? (JSON.parse(content[0].text) as Record<string, unknown>) : undefined,
  };
}

describe('MCP OAuth backend', () => {
  let userDir: string;
  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-oauth-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(userDir, { recursive: true, force: true });
  });

  it('serves AS and both PRM endpoints on httpNode', async () => {
    const { admin, node } = appFor(userDir);
    const as = await request(node!).get('/.well-known/oauth-authorization-server');
    expect(as.body).toMatchObject({
      issuer,
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['read', 'propose'],
    });
    expect(as.body).not.toHaveProperty('client_id_metadata_document_supported');
    expect(
      (await request(node!).get('/.well-known/oauth-protected-resource/mcp')).body.resource
    ).toBe(resource);
    expect((await request(node!).get('/.well-known/oauth-protected-resource')).body.resource).toBe(
      resource
    );
    expect((await request(admin).get('/.well-known/oauth-authorization-server')).status).toBe(404);
  });

  it('allows an HTTP public URL with a warning and functional token endpoint', async () => {
    const publicUrl = 'http://remote.example';
    const { admin } = appFor(userDir, { publicUrl });
    expect((await request(admin).get('/mcp/api/v1/settings')).body.oauthPublicUrlWarning).toContain(
      'HTTPS'
    );
    const id = (await register(admin)).body.client_id as string;
    const code = (await authorize(admin, id, `${publicUrl}/mcp`)).code!;
    expect((await exchange(admin, id, code, `${publicUrl}/mcp`)).status).toBe(200);
  });

  it('falls back to metadata under /mcp and reports the fallback', async () => {
    const { admin } = appFor(userDir, { fallback: true });
    expect(
      (await request(admin).get('/mcp/.well-known/oauth-protected-resource/mcp')).body.resource
    ).toBe(resource);
    expect((await request(admin).get('/mcp/api/v1/oauth/status')).body.httpNodeRootFallback).toBe(
      true
    );
  });

  it('requires S256, single-use codes, resource binding, and hashes token storage', async () => {
    const { admin } = appFor(userDir);
    const client = await register(admin);
    expect(client.status).toBe(201);
    const id = client.body.client_id as string;
    expect((await authorize(admin, id, resource, 'plain')).page.status).toBe(400);
    expect((await authorize(admin, id, 'https://other.example/mcp')).page.status).toBe(400);
    const flow = await authorize(admin, id);
    expect(flow.page.text).toContain('Test client');
    expect(flow.page.text).toContain('127.0.0.1');
    expect(flow.page.text).toContain('Warning');
    expect(flow.granted?.status).toBe(200);
    expect((await exchange(admin, id, flow.code, 'https://other.example/mcp')).status).toBe(400);
    const second = (await authorize(admin, id)).code!;
    const issued = await exchange(admin, id, second);
    expect(issued.status).toBe(200);
    expect((await exchange(admin, id, second)).status).toBe(400);
    const disk = readFileSync(join(userDir, '.ai-access', 'oauth.json'), 'utf8');
    expect(disk).not.toContain(issued.body.access_token as string);
    expect(disk).not.toContain(issued.body.refresh_token as string);
    const rpc = await request(admin)
      .post('/mcp/rpc')
      .set('Authorization', `Bearer ${issued.body.access_token as string}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(rpc.status).toBe(200);
    // `/mcp` is the protected resource URL users add in ChatGPT: it must serve MCP too.
    const bearer = `Bearer ${issued.body.access_token as string}`;
    const mcpInit = await request(admin)
      .post('/mcp')
      .set('Authorization', bearer)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'chatgpt-like', version: '1' },
        },
      });
    expect(mcpInit.status).toBe(200);
    const mcpList = await request(admin)
      .post('/mcp')
      .set('Authorization', bearer)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(mcpList.status).toBe(200);
    expect(JSON.stringify(mcpList.body)).toContain('list_flows');
  });

  it('serves MCP at /mcp: 401 with resource_metadata, SSE GET 405, browsers still get the page', async () => {
    const { admin } = appFor(userDir);
    const unauth = await request(admin)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers['www-authenticate']).toContain(
      'resource_metadata="https://node.example/.well-known/oauth-protected-resource/mcp"'
    );
    const prm = await request(appFor(userDir).node!).get(
      '/.well-known/oauth-protected-resource/mcp'
    );
    expect(prm.body.resource).toBe(resource);
    const sse = await request(admin).get('/mcp').set('Accept', 'text/event-stream');
    expect(sse.status).toBe(401);
    const page = await request(admin).get('/mcp').set('Accept', 'text/html,*/*');
    expect(page.status).toBe(200);
    expect(page.type).toBe('text/html');
  });

  it('rotates refresh tokens and revokes a family on reuse', async () => {
    const { admin } = appFor(userDir);
    const id = (await register(admin)).body.client_id as string;
    const code = (await authorize(admin, id)).code!;
    const initial = (await exchange(admin, id, code)).body;
    const refresh = (token: string) =>
      request(admin)
        .post('/mcp/oauth/token')
        .type('form')
        .send({ grant_type: 'refresh_token', client_id: id, refresh_token: token, resource });
    const rotated = await refresh(initial.refresh_token as string);
    expect(rotated.status).toBe(200);
    expect((await refresh(initial.refresh_token as string)).status).toBe(400);
    expect((await refresh(rotated.body.refresh_token as string)).status).toBe(400);
  });

  it('revokes an OAuth token family through the SDK revocation endpoint', async () => {
    const { admin } = appFor(userDir);
    const id = (await register(admin)).body.client_id as string;
    const code = (await authorize(admin, id)).code!;
    const tokens = (await exchange(admin, id, code)).body;
    const revoked = await request(admin)
      .post('/mcp/oauth/revoke')
      .type('form')
      .send({ client_id: id, token: tokens.refresh_token });
    expect(revoked.status).toBe(200);
    const denied = await request(admin)
      .post('/mcp/rpc')
      .set('Authorization', `Bearer ${tokens.access_token as string}`)
      .send({});
    expect(denied.status).toBe(401);
  });

  it('expires codes after 60 seconds and resets refresh idle expiry on rotation', async () => {
    const { admin } = appFor(userDir, { refreshTtl: 120, accessTtl: 30 });
    const id = (await register(admin)).body.client_id as string;
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(base);
    const old = (await authorize(admin, id)).code!;
    clock.mockReturnValue(base + 60_001);
    expect((await exchange(admin, id, old)).status).toBe(400);
    const fresh = (await authorize(admin, id)).code!;
    const issued = (await exchange(admin, id, fresh)).body;
    const file = () =>
      JSON.parse(readFileSync(join(userDir, '.ai-access', 'oauth.json'), 'utf8')) as {
        tokens: { hash: string; type: string; expires: number }[];
      };
    const oldExpiry = Math.max(
      ...file()
        .tokens.filter(t => t.type === 'refresh')
        .map(t => t.expires)
    );
    clock.mockReturnValue(base + 60_001 + 90_000);
    const rotated = await request(admin).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: id,
      refresh_token: issued.refresh_token,
      resource,
    });
    expect(rotated.status).toBe(200);
    const newExpiry = Math.max(
      ...file()
        .tokens.filter(t => t.type === 'refresh')
        .map(t => t.expires)
    );
    expect(newExpiry).toBe(oldExpiry + 90_000);
    expect(rotated.body.expires_in).toBe(30);
  });

  it('prunes rotated refresh tokens once they expire', async () => {
    const { admin } = appFor(userDir, { refreshTtl: 120 });
    const id = (await register(admin)).body.client_id as string;
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(base);
    const code = (await authorize(admin, id)).code!;
    const issued = (await exchange(admin, id, code)).body;
    clock.mockReturnValue(base + 60_000);
    const rotated = await request(admin).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: id,
      refresh_token: issued.refresh_token,
      resource,
    });
    expect(rotated.status).toBe(200);
    clock.mockReturnValue(base + 121_000);
    await request(admin).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: id,
      refresh_token: 'unknown',
      resource,
    });
    const tokens = (
      JSON.parse(readFileSync(join(userDir, '.ai-access', 'oauth.json'), 'utf8')) as {
        tokens: { rotated: boolean; expires: number }[];
      }
    ).tokens;
    expect(tokens.filter(t => t.rotated)).toHaveLength(0);
    expect(tokens.every(t => t.expires > base + 121_000)).toBe(true);
  });

  it('burns an authorization code on the first exchange attempt even when PKCE fails', async () => {
    const { admin } = appFor(userDir);
    const id = (await register(admin)).body.client_id as string;
    const code = (await authorize(admin, id)).code!;
    expect((await exchange(admin, id, code, resource, 'b'.repeat(43))).status).toBe(400);
    expect((await exchange(admin, id, code)).status).toBe(400);
    const code2 = (await authorize(admin, id)).code!;
    const wrongRedirect = await request(admin).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      client_id: id,
      code: code2,
      code_verifier: verifier,
      redirect_uri: 'http://127.0.0.1:3456/other',
      resource,
    });
    expect(wrongRedirect.status).toBe(400);
    expect((await exchange(admin, id, code2)).status).toBe(400);
  });

  it('rejects OAuth RPC, consent and token calls when AI Access is disabled', async () => {
    const { admin } = appFor(userDir);
    const id = (await register(admin)).body.client_id as string;
    const code = (await authorize(admin, id)).code!;
    const issued = (await exchange(admin, id, code)).body;
    const pending = (await authorize(admin, id)).code!;
    const off = appFor(userDir, { enabled: false }).admin;
    const rpc = await request(off)
      .post('/mcp/rpc')
      .set('Authorization', `Bearer ${issued.access_token as string}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(rpc.status).toBe(403);
    expect((await authorize(off, id)).page.status).toBe(403);
    expect((await exchange(off, id, pending)).status).toBe(403);
    const refresh = await request(off).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: id,
      refresh_token: issued.refresh_token,
      resource,
    });
    expect(refresh.status).toBe(403);
  });

  it('enforces the optional refresh max lifetime across rotations', async () => {
    const { admin } = appFor(userDir, { refreshTtl: 120, refreshMax: 100 });
    const id = (await register(admin)).body.client_id as string;
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(base);
    const code = (await authorize(admin, id)).code!;
    const issued = (await exchange(admin, id, code)).body;
    const refresh = (token: string) =>
      request(admin)
        .post('/mcp/oauth/token')
        .type('form')
        .send({ grant_type: 'refresh_token', client_id: id, refresh_token: token, resource });
    clock.mockReturnValue(base + 60_000);
    const rotated = await refresh(issued.refresh_token as string);
    expect(rotated.status).toBe(200);
    clock.mockReturnValue(base + 101_000);
    expect((await refresh(rotated.body.refresh_token as string)).status).toBe(400);
  });

  it('keeps one client from evicting pending consents of another client and rate limits authorize floods', async () => {
    const { admin } = appFor(userDir);
    const victim = (await register(admin)).body.client_id as string;
    const attacker = (await register(admin)).body.client_id as string;
    const victimPage = await request(admin)
      .get('/mcp/oauth/authorize')
      .query(consentParams(victim));
    const first = await request(admin).get('/mcp/oauth/authorize').query(consentParams(attacker));
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++)
      statuses.push(
        (await request(admin).get('/mcp/oauth/authorize').query(consentParams(attacker))).status
      );
    expect(statuses).toContain(429);
    expect((await approve(admin, victimPage)).code).toBeTruthy();
    expect((await approve(admin, first)).details.status).toBe(404);
  });

  it('rejects cross-origin consent decisions without consuming the request', async () => {
    const { admin } = appFor(userDir, { session: true });
    const id = (await register(admin)).body.client_id as string;
    const page = await request(admin).get('/mcp/oauth/authorize').query(consentParams(id));
    const reqId = /data-request="([^"]+)"/.exec(page.text)![1]!;
    const details = await request(admin)
      .get(`/mcp/oauth/consent/${reqId}`)
      .set('x-test-user', 'alice');
    const forged = await request(admin)
      .post(`/mcp/oauth/consent/${reqId}`)
      .set('x-test-user', 'alice')
      .set('Origin', 'https://attacker.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ csrf: details.body.csrf, decision: 'allow' });
    expect(forged.status).toBe(403);
    expect(forged.body.redirect).toBeUndefined();
    const legit = await request(admin)
      .post(`/mcp/oauth/consent/${reqId}`)
      .set('x-test-user', 'alice')
      .set('Origin', issuer)
      .set('Sec-Fetch-Site', 'same-origin')
      .send({ csrf: details.body.csrf, decision: 'allow' });
    expect(legit.status).toBe(200);
  });

  it('rejects access and refresh tokens after revocation', async () => {
    const { admin } = appFor(userDir);
    const id = (await register(admin)).body.client_id as string;
    const code = (await authorize(admin, id)).code!;
    const tokens = (await exchange(admin, id, code)).body;
    const revoke = await request(admin)
      .post('/mcp/oauth/revoke')
      .type('form')
      .send({ client_id: id, token: tokens.access_token });
    expect(revoke.status).toBe(200);
    const rpc = await request(admin)
      .post('/mcp/rpc')
      .set('Authorization', `Bearer ${tokens.access_token as string}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(rpc.status).toBe(401);
    const refresh = await request(admin).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: id,
      refresh_token: tokens.refresh_token,
      resource,
    });
    expect(refresh.status).toBe(400);
  });

  it('rejects invalid refreshMaxLifetimeSec values on PUT /settings', async () => {
    const { admin } = appFor(userDir, { oauthFromDisk: true });
    for (const bad of [-1, 1.5, '30', 315_360_001, null]) {
      const res = await request(admin)
        .put('/mcp/api/v1/settings')
        .send({ oauth: { refreshMaxLifetimeSec: bad } });
      expect(res.status, String(bad)).toBe(400);
    }
    const ok = await request(admin)
      .put('/mcp/api/v1/settings')
      .send({ oauth: { refreshMaxLifetimeSec: 0 } });
    expect(ok.status).toBe(200);
  });

  it('starts the max lifetime clock for legacy families without familyStart at first refresh', async () => {
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(base);
    const first = appFor(userDir, { refreshMax: 100, refreshTtl: 3600 }).admin;
    const id = (await register(first)).body.client_id as string;
    const code = (await authorize(first, id)).code!;
    const issued = (await exchange(first, id, code)).body;
    const file = join(userDir, '.ai-access', 'oauth.json');
    const db = JSON.parse(readFileSync(file, 'utf8')) as {
      tokens: { familyStart?: number; expires: number; type: string }[];
    };
    for (const t of db.tokens) {
      delete t.familyStart;
      if (t.type === 'refresh') t.expires = base + 3_600_000;
    }
    writeFileSync(file, JSON.stringify(db));
    const admin = appFor(userDir, { refreshMax: 100, refreshTtl: 3600 }).admin;
    const refresh = (token: string) =>
      request(admin)
        .post('/mcp/oauth/token')
        .type('form')
        .send({ grant_type: 'refresh_token', client_id: id, refresh_token: token, resource });
    clock.mockReturnValue(base + 500_000);
    const rotated = await refresh(issued.refresh_token as string);
    expect(rotated.status).toBe(200);
    clock.mockReturnValue(base + 550_000);
    const again = await refresh(rotated.body.refresh_token as string);
    expect(again.status).toBe(200);
    clock.mockReturnValue(base + 601_000);
    expect((await refresh(again.body.refresh_token as string)).status).toBe(400);
  });

  it('keeps aia_ MCP links working while OAuth is enabled', async () => {
    const { admin, linkStore } = appFor(userDir);
    const link = linkStore.create({ kind: 'mcp', label: 'legacy' });
    const response = await request(admin)
      .post('/mcp/rpc')
      .set('Authorization', `Bearer ${link.token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(response.status).toBe(200);
    const invalid = await request(admin)
      .post('/mcp/rpc')
      .set('Authorization', 'Bearer aia_invalid')
      .send({});
    expect(invalid.status).toBe(401);
    expect(invalid.headers['www-authenticate']).toContain('resource_metadata=');
  });

  it('caps DCR clients and rejects unsafe redirects', async () => {
    const { admin } = appFor(userDir, { cap: 1 });
    expect((await register(admin, 'http://evil.example/cb')).status).toBe(400);
    const first = (await register(admin)).body.client_id as string;
    expect((await register(admin)).status).toBe(201);
    await authorize(admin, first);
    expect((await register(admin)).status).toBe(400);
  });

  it('expires never-consented clients after an hour and keeps approved ones', async () => {
    const { admin } = appFor(userDir);
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(base);
    const approved = (await register(admin)).body.client_id as string;
    const idle = (await register(admin)).body.client_id as string;
    await authorize(admin, approved);
    clock.mockReturnValue(base + 3_600_001);
    const page = (id: string) =>
      request(admin).get('/mcp/oauth/authorize').query(consentParams(id));
    expect((await page(idle)).status).toBe(400);
    expect((await page(approved)).status).toBe(200);
  });

  it('limits registrations to ten per hour per IP', async () => {
    const { admin } = appFor(userDir);
    for (let i = 0; i < 10; i++) expect((await register(admin)).status).toBe(201);
    expect((await register(admin)).status).toBe(429);
  });

  it('requires an admin session for consent and client administration', async () => {
    const { admin } = appFor(userDir, { session: true });
    const id = (await register(admin)).body.client_id as string;
    const params = consentParams(id);
    const page = await request(admin).get('/mcp/oauth/authorize').query(params);
    expect(page.status).toBe(200);
    expect((await approve(admin, page)).details.status).toBe(401);
    expect((await request(admin).get('/mcp/api/v1/oauth/clients')).status).toBe(401);
    expect(
      (await request(admin).get('/mcp/api/v1/oauth/clients').set('x-test-user', 'alice')).body
        .clients
    ).toHaveLength(1);
    const flow = await approve(admin, page, 'alice');
    expect(flow.granted?.status).toBe(200);
    const token = await exchange(admin, id, flow.code!);
    expect(token.status).toBe(200);
    expect(token.body.scope).toBe('read propose');
    const revoked = await request(admin)
      .delete(`/mcp/api/v1/oauth/clients/${id}`)
      .set('x-test-user', 'alice');
    expect(revoked.body.revoked).toBe(true);
    expect(
      (await request(admin).get('/mcp/api/v1/oauth/clients').set('x-test-user', 'alice')).body
        .clients
    ).toHaveLength(0);
    expect(
      (
        await request(admin)
          .post('/mcp/rpc')
          .set('Authorization', `Bearer ${token.body.access_token as string}`)
          .send({})
      ).status
    ).toBe(401);
  });

  it('never grants propose to an approver with read-only permission', async () => {
    const { admin } = appFor(userDir, { session: true });
    const id = (await register(admin)).body.client_id as string;
    const flow = await authorize(admin, id, resource, 'S256', 'read propose', 'bob');
    expect(flow.details?.body.grantable).toEqual(['read']);
    const token = await exchange(admin, id, flow.code);
    expect(token.status).toBe(200);
    expect(token.body.scope).toBe('read');
    const proposeOnly = await authorize(admin, id, resource, 'S256', 'propose', 'bob');
    expect(proposeOnly.details?.status).toBe(403);
  });

  it('escapes the client name on the consent page', async () => {
    const { admin } = appFor(userDir);
    const reg = await request(admin)
      .post('/mcp/oauth/register')
      .send({
        client_name: '<img src=x onerror=alert(1)>"\'',
        redirect_uris: ['http://127.0.0.1:3456/callback'],
        token_endpoint_auth_method: 'none',
      });
    const page = await request(admin)
      .get('/mcp/oauth/authorize')
      .query(consentParams(reg.body.client_id as string));
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('<img src=x');
    expect(page.text).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;');
  });

  it('hardens the consent page and its decision endpoint', async () => {
    const { admin } = appFor(userDir, { session: true });
    const id = (await register(admin)).body.client_id as string;
    const page = await request(admin).get('/mcp/oauth/authorize').query(consentParams(id));
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+'/);
    expect(page.text.indexOf('127.0.0.1')).toBeLessThan(page.text.indexOf('Test client'));
    // Branded, self-contained page: no external assets, sign-in form + permission list.
    expect(page.text).toContain('Node-RED AI Access');
    expect(page.text).not.toMatch(/(src|href)="https?:/);
    expect(page.text).toContain('id="login"');
    expect(page.text).toContain('Propose flow changes');
    expect(
      (await request(admin).post('/mcp/oauth/authorize').type('form').send({})).status
    ).not.toBe(302);
    const reqId = /data-request="([^"]+)"/.exec(page.text)![1]!;
    const details = await request(admin)
      .get(`/mcp/oauth/consent/${reqId}`)
      .set('x-test-user', 'alice');
    const post = (body: Record<string, unknown>, headers: Record<string, string>) =>
      request(admin)
        .post(`/mcp/oauth/consent/${reqId}`)
        .set('x-test-user', 'alice')
        .set(headers)
        .send(body);
    expect((await post({ csrf: 'wrong', decision: 'allow' }, {})).status).toBe(403);
    expect(
      (
        await post(
          { csrf: details.body.csrf, decision: 'allow' },
          { Origin: 'https://evil.example' }
        )
      ).status
    ).toBe(403);
    expect(
      (
        await post(
          { csrf: details.body.csrf, decision: 'allow' },
          { 'Sec-Fetch-Site': 'cross-site' }
        )
      ).status
    ).toBe(403);
    const other = await request(admin).get('/mcp/oauth/authorize').query(consentParams(id));
    const otherId = /data-request="([^"]+)"/.exec(other.text)![1]!;
    expect(
      (
        await request(admin)
          .post(`/mcp/oauth/consent/${otherId}`)
          .set('x-test-user', 'alice')
          .send({ csrf: details.body.csrf, decision: 'allow' })
      ).status
    ).toBe(403);
    const denied = await post(
      { csrf: details.body.csrf, decision: 'deny' },
      { 'Sec-Fetch-Site': 'same-origin' }
    );
    expect(denied.status).toBe(200);
    expect(denied.body.redirect).toContain('error=access_denied');
    expect((await post({ csrf: details.body.csrf, decision: 'allow' }, {})).status).toBe(404);
  });

  it('maps OAuth scopes to MCP tools and records client and user ownership', async () => {
    const { admin } = appFor(userDir);
    const id = (await register(admin)).body.client_id as string;
    const code = (await authorize(admin, id)).code!;
    const token = (await exchange(admin, id, code)).body.access_token as string;
    const status = await callTool(admin, token, 'get_status');
    expect(status.value).toMatchObject({
      permission: 'propose',
      caller: { kind: 'oauth', clientId: id, user: 'owner' },
    });
    const submitted = await callTool(admin, token, 'submit_proposal', {
      type: 'replace_flow',
      expectedRev: 'r1',
      payload: { flowId: 'flow', flow: { id: 'flow', type: 'tab', label: 'Main', nodes: [] } },
    });
    expect(submitted.response.status).toBe(200);
    expect(submitted.response.body.result?.isError).toBeFalsy();
    expect(submitted.value?.createdBy).toEqual({ kind: 'oauth', clientId: id, user: 'owner' });
    const mine = await callTool(admin, token, 'list_my_proposals', { mine: true });
    expect(mine.value?.proposals as { id: string; mine: boolean }[]).toEqual([
      expect.objectContaining({ id: submitted.value?.id, mine: true }),
    ]);
  });

  it('keeps proposal tools out of read-only tokens and reports insufficient scope', async () => {
    const { admin } = appFor(userDir);
    const id = (await register(admin)).body.client_id as string;
    const readCode = (await authorize(admin, id, resource, 'S256', 'read')).code!;
    const readToken = (await exchange(admin, id, readCode)).body.access_token as string;
    const listed = await request(admin)
      .post('/mcp/rpc')
      .set('Authorization', `Bearer ${readToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((listed.body.result?.tools as { name: string }[]).map(tool => tool.name)).not.toContain(
      'submit_proposal'
    );
    const proposeCode = (await authorize(admin, id, resource, 'S256', 'propose')).code!;
    const proposeToken = (await exchange(admin, id, proposeCode)).body.access_token as string;
    const denied = await request(admin)
      .post('/mcp/rpc')
      .set('Authorization', `Bearer ${proposeToken}`)
      .send({});
    expect(denied.status).toBe(403);
    expect(denied.headers['www-authenticate']).toContain('error="insufficient_scope"');
    expect(denied.headers['www-authenticate']).toContain('scope="read propose"');
    expect(denied.headers['www-authenticate']).toContain('resource_metadata=');
  });

  it('detects collisions on Express 4 style apps without touching the deprecated router getter', () => {
    const express4 = {
      _router: {
        stack: [
          { name: 'bound dispatch', route: { path: '/.well-known/oauth-authorization-server' } },
          { name: 'mounted', regexp: /^\/mcp\/oauth\/?(?=\/|$)/i },
          { name: 'query', regexp: /^\/?(?=\/|$)/i },
        ],
      },
      get router(): never {
        throw new Error("'app.router' is deprecated!");
      },
    };
    expect(detectOAuthRouteCollisions(express4)).toHaveLength(2);
    const lazy = {
      get router(): never {
        throw new Error("'app.router' is deprecated!");
      },
    };
    expect(detectOAuthRouteCollisions(lazy)).toEqual([]);
  });

  it('reports collisions and includes OAuth discovery on unauthenticated MCP responses', async () => {
    const app = express();
    app.get('/mcp/oauth/token', (_req, res) => res.end());
    expect(detectOAuthRouteCollisions(app, ['/mcp/oauth/'])).toHaveLength(1);
    const { admin } = appFor(userDir);
    const denied = await request(admin).post('/mcp/rpc').send({});
    expect(denied.status).toBe(401);
    expect(denied.headers['www-authenticate']).toContain('resource_metadata=');
    expect(denied.headers['www-authenticate']).toContain('scope="read propose"');
  });

  it('disables collided authorization routes at startup and after flows restart', async () => {
    const initial = appFor(userDir, { collision: true });
    const status = await request(initial.admin).get('/mcp/api/v1/oauth/status');
    expect(status.body.authorization.join(' ')).toContain('/mcp/oauth/token');
    expect((await request(initial.admin).post('/mcp/oauth/register').send({})).status).toBe(404);
    const secondDir = mkdtempSync(join(tmpdir(), 'ai-access-oauth-'));
    const later = appFor(secondDir);
    later.admin.get('/mcp/oauth/revoke', (_req, res) => res.send('existing'));
    later.events.emit('flows:started');
    expect(
      (await request(later.admin).get('/mcp/api/v1/oauth/status')).body.authorization.join(' ')
    ).toContain('/mcp/oauth/revoke');
    rmSync(secondDir, { recursive: true, force: true });
  });

  it('ignores disabled http-in nodes and nodes on disabled tabs', () => {
    const nodes: FlowNodeLike[] = [
      { id: 't1', type: 'tab', disabled: true },
      { id: 't2', type: 'tab' },
      {
        id: 'a',
        type: 'http in',
        url: '/.well-known/oauth-authorization-server',
        z: 't2',
        d: true,
      },
      { id: 'b', type: 'http in', url: '/.well-known/oauth-protected-resource', z: 't1' },
      { id: 'c', type: 'http in', url: '.well-known/oauth-x', z: 't2', name: 'Mine' },
    ];
    expect(findHttpInCollisions(fn => nodes.forEach(fn), ['/.well-known/oauth-'])).toEqual([
      { path: '/.well-known/oauth-x', source: 'http-in', nodeId: 'c', nodeName: 'Mine' },
    ]);
  });

  it('re-evaluates http-in collisions on deploy and reports each node once with id and name', async () => {
    const flowNodes: FlowNodeLike[] = [
      { id: 't', type: 'tab' },
      {
        id: 'n1',
        type: 'http in',
        url: '/.well-known/oauth-authorization-server',
        z: 't',
        d: true,
      },
    ];
    const app = appFor(userDir, { flowNodes });
    app.events.emit('flows:started');
    let status = (await request(app.admin).get('/mcp/api/v1/oauth/status')).body;
    expect(status.collisions).toEqual([]);
    expect((await request(app.node!).get('/.well-known/oauth-authorization-server')).status).toBe(
      200
    );

    // Enable it: Node-RED registers an Express route ('bound dispatch') and the node is live.
    flowNodes[1] = { ...flowNodes[1], d: false, name: 'Meta' };
    const handler = (_req: unknown, res: { send(b: string): void }) => res.send('flow');
    app.node!.get('/.well-known/oauth-authorization-server', handler);
    app.events.emit('flows:started');
    status = (await request(app.admin).get('/mcp/api/v1/oauth/status')).body;
    expect(status.details).toEqual([
      {
        kind: 'metadata',
        path: '/.well-known/oauth-authorization-server',
        source: 'http-in',
        nodeId: 'n1',
        nodeName: 'Meta',
      },
    ]);
    expect(status.metadata[0]).toContain("http-in node 'Meta'");

    // Disable again: Node-RED removes the route on close; collision clears on next deploy.
    flowNodes[1] = { ...flowNodes[1], d: true };
    const stack = app.node as unknown as {
      _router?: { stack: { route?: unknown }[] };
      router?: { stack: { route?: unknown }[] };
    };
    const layers = (stack._router ?? stack.router)!.stack;
    layers.splice(
      layers.findIndex(l => l.route),
      1
    );
    app.events.emit('flows:started');
    status = (await request(app.admin).get('/mcp/api/v1/oauth/status')).body;
    expect(status.collisions).toEqual([]);
  });

  it('counts http-in nodes in subflow templates only when a running instance exists', () => {
    const base: FlowNodeLike[] = [
      { id: 'tab', type: 'tab' },
      { id: 'off', type: 'tab', disabled: true },
      { id: 'sf', type: 'subflow' },
      { id: 'h', type: 'http in', url: '/mcp/oauth/token', z: 'sf' },
    ];
    const run = (extra: FlowNodeLike[]) =>
      findHttpInCollisions(fn => [...base, ...extra].forEach(fn), ['/mcp/oauth/']);
    expect(run([])).toEqual([]);
    expect(run([{ id: 'i1', type: 'subflow:sf', z: 'tab', d: true }])).toEqual([]);
    expect(run([{ id: 'i2', type: 'subflow:sf', z: 'off' }])).toEqual([]);
    expect(run([{ id: 'i3', type: 'subflow:sf', z: 'tab' }])).toHaveLength(1);
    // nested: subflow sf used inside subflow outer, which has an enabled instance
    expect(
      run([
        { id: 'outer', type: 'subflow' },
        { id: 'i4', type: 'subflow:sf', z: 'outer' },
        { id: 'i5', type: 'subflow:outer', z: 'tab' },
      ])
    ).toHaveLength(1);
  });

  it('compares real mounted paths using httpAdminRoot and httpNodeRoot', () => {
    const node = express();
    node.get('/mcp/oauth/token', (_req, res) => res.end());
    const nodes: FlowNodeLike[] = [
      { id: 't', type: 'tab' },
      { id: 'n', type: 'http in', url: '/mcp/oauth/token', z: 't' },
    ];
    const base = {
      httpAdmin: express(),
      httpNode: node,
      metadataFallback: false,
      eachNode: (fn: (n: FlowNodeLike) => void) => nodes.forEach(fn),
    };
    // httpNodeRoot '/api': node route is /api/mcp/oauth/token -> no collision
    expect(
      scanOAuthRouteCollisions({ ...base, httpAdminRoot: '/', httpNodeRoot: '/api' }).authorization
    ).toEqual([]);
    // Same roots -> collision, reported once as the node
    expect(
      scanOAuthRouteCollisions({ ...base, httpAdminRoot: '/', httpNodeRoot: '/' }).authorization
    ).toEqual([{ path: '/mcp/oauth/token', source: 'http-in', nodeId: 'n', nodeName: undefined }]);
    // httpAdminRoot '/admin' + httpNodeRoot '/admin' -> collision
    expect(
      scanOAuthRouteCollisions({ ...base, httpAdminRoot: '/admin', httpNodeRoot: '/admin/' })
        .authorization
    ).toHaveLength(1);
    // httpAdminRoot '/admin', httpNodeRoot '/' + http-in /admin/mcp/oauth/x -> collision
    const adminNodes: FlowNodeLike[] = [{ id: 'm', type: 'http in', url: '/ADMIN/mcp/OAuth/x' }];
    expect(
      scanOAuthRouteCollisions({
        httpAdmin: express(),
        httpNode: express(),
        httpAdminRoot: '/admin',
        httpNodeRoot: '/',
        metadataFallback: false,
        eachNode: fn => adminNodes.forEach(fn),
      }).authorization
    ).toHaveLength(1);
  });

  it('keeps different sources at the same path and survives eachNode throwing', () => {
    const admin = express();
    admin.get('/mcp/oauth/token', (_req, res) => res.end());
    const node = express();
    node.get('/MCP/oauth/token', (_req, res) => res.end());
    const scan = scanOAuthRouteCollisions({
      httpAdmin: admin,
      httpNode: node,
      httpAdminRoot: '/',
      httpNodeRoot: '/',
      metadataFallback: false,
      eachNode: () => {
        throw new Error('not started');
      },
      staticDirs: ['/srv/static'],
      fileExists: p => p === '/srv/static/mcp/oauth/token',
    });
    expect(scan.authorization.map(c => c.source)).toEqual(['route', 'httpStatic']);
    // httpStaticRoot '/static': files are served under /static, so no collision.
    expect(
      scanOAuthRouteCollisions({
        httpAdmin: express(),
        httpAdminRoot: '/',
        metadataFallback: true,
        staticDirs: ['/srv/static'],
        httpStaticRoot: '/static',
        fileExists: p => p === '/srv/static/mcp/oauth/token',
      }).authorization
    ).toEqual([]);
    // per-entry root that reaches the OAuth path collides
    expect(
      scanOAuthRouteCollisions({
        httpAdmin: express(),
        httpAdminRoot: '/',
        metadataFallback: true,
        staticDirs: [{ path: '/srv/x', root: '/mcp' }],
        httpStaticRoot: '/static',
        fileExists: p => p === '/srv/x/oauth/token',
      }).authorization
    ).toEqual([{ path: '/mcp/oauth/token', source: 'httpStatic', file: '/srv/x/oauth/token' }]);
    expect(scan.authorization[1]).toMatchObject({
      path: '/mcp/oauth/token',
      file: '/srv/static/mcp/oauth/token',
    });
  });

  it('hides absolute httpStatic file paths from non-admin users in /oauth/status', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'ai-access-static-'));
    mkdirSync(join(staticDir, '.well-known'), { recursive: true });
    writeFileSync(join(staticDir, '.well-known', 'oauth-authorization-server'), '{}');
    const app = appFor(userDir, { session: true, httpStatic: staticDir });
    const admin = (
      await request(app.admin).get('/mcp/api/v1/oauth/status').set('x-test-user', 'alice')
    ).body;
    const viewer = (
      await request(app.admin).get('/mcp/api/v1/oauth/status').set('x-test-user', 'bob')
    ).body;
    expect(admin.details[0].file).toContain(staticDir);
    expect(viewer.details[0].file).toBeUndefined();
    expect(JSON.stringify(viewer)).not.toContain(staticDir);
    rmSync(staticDir, { recursive: true, force: true });
  });

  it('normalizes scheme, host, and trailing slash for resource indicators', () => {
    expect(canonicalResource('HTTPS://NODE.EXAMPLE/mcp/')).toBe(resource);
  });
});
