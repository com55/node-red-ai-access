import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import { canonicalResource, detectOAuthRouteCollisions } from '../../src/plugin/oauth.js';
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
      ...(options.session ? { adminAuth: { type: 'credentials' } } : {}),
      aiAccess: {
        ...(options.enabled === false ? { enabled: false } : {}),
        allowWithoutAdminAuth: true,
        publicBaseUrl: options.publicUrl ?? issuer,
        oauth: {
          enabled: true,
          dcrMaxClients: options.cap ?? 20,
          accessTokenTtlSec: options.accessTtl ?? 3600,
          refreshIdleTtlSec: options.refreshTtl ?? 2_592_000,
        },
      },
    },
    httpAdmin: admin,
    ...(node ? { httpNode: node } : {}),
    events,
    auth: {
      needsPermission: () => (req, res, next) => {
        if (options.session && req.headers['x-test-user'] !== 'alice') {
          res.status(401).end();
          return;
        }
        if (options.session)
          Object.assign(req, { user: { username: 'alice@example.com', permissions: '*' } });
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
async function authorize(
  app: Express,
  clientId: string,
  resourceUrl = resource,
  method = 'S256',
  scope = 'read propose'
) {
  const params = {
    client_id: clientId,
    redirect_uri: 'http://127.0.0.1:3456/callback',
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: method,
    scope,
    resource: resourceUrl,
    state: 'abc',
  };
  const page = await request(app).get('/mcp/oauth/authorize').query(params);
  if (page.status !== 200) return { page };
  const granted = await request(app)
    .post('/mcp/oauth/authorize')
    .type('form')
    .send({ ...params, accept: '1' });
  return {
    page,
    granted,
    code: new URL(granted.headers.location!).searchParams.get('code'),
  };
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
    expect(flow.granted?.status).toBe(302);
    expect((await exchange(admin, id, flow.code!, 'https://other.example/mcp')).status).toBe(400);
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
    expect((await register(admin)).status).toBe(201);
    expect((await register(admin)).status).toBe(400);
  });

  it('limits registrations to ten per hour per IP', async () => {
    const { admin } = appFor(userDir);
    for (let i = 0; i < 10; i++) expect((await register(admin)).status).toBe(201);
    expect((await register(admin)).status).toBe(429);
  });

  it('requires an admin session for consent and client administration', async () => {
    const { admin } = appFor(userDir, { session: true });
    const id = (await register(admin)).body.client_id as string;
    const params = {
      client_id: id,
      redirect_uri: 'http://127.0.0.1:3456/callback',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'read propose',
      resource,
    };
    expect((await request(admin).get('/mcp/oauth/authorize').query(params)).status).toBe(401);
    expect((await request(admin).get('/mcp/oauth/authorize/').query(params)).status).toBe(401);
    expect((await request(admin).get('/mcp/oauth/Authorize').query(params)).status).toBe(401);
    expect(
      (await request(admin).get('/mcp/oauth/authorize').set('x-test-user', 'alice').query(params))
        .status
    ).toBe(200);
    expect((await request(admin).get('/mcp/api/v1/oauth/clients')).status).toBe(401);
    expect(
      (await request(admin).get('/mcp/api/v1/oauth/clients').set('x-test-user', 'alice')).body
        .clients
    ).toHaveLength(1);
    const granted = await request(admin)
      .post('/mcp/oauth/authorize')
      .set('x-test-user', 'alice')
      .type('form')
      .send({ ...params, accept: '1' });
    expect(granted.status).toBe(302);
    const token = await exchange(
      admin,
      id,
      new URL(granted.headers.location!).searchParams.get('code')!
    );
    expect(token.status).toBe(200);
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

  it('normalizes scheme, host, and trailing slash for resource indicators', () => {
    expect(canonicalResource('HTTPS://NODE.EXAMPLE/mcp/')).toBe(resource);
  });
});
