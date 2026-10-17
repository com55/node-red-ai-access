/**
 * Self-contained GET access links: /mcp/a/<token>/…
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import {
  DEFAULT_ACCESS_LINK_TTL_SECONDS,
  MAX_GET_ACCESS_URL_BYTES,
  redactAccessLinkTokenInPath,
} from '../../src/plugin/access-path.js';
import { registerRoutes } from '../../src/plugin/index.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter, FlowTab } from '../../src/runtime/types.js';

function createApp(options: { userDir: string; adapter?: FlowAdapter }): {
  app: Express;
  linkStore: AccessLinkStore;
} {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 10, defaultTtlSeconds: 14_400 });

  const flow: FlowTab = {
    id: 'tab-1',
    type: 'tab',
    label: 'Main',
    nodes: [
      { id: 'n1', type: 'inject', z: 'tab-1', name: 'Old' },
      { id: 'n2', type: 'template', z: 'tab-1', name: 'Tpl', template: '<p>hi</p>' },
    ],
  };

  const adapter: FlowAdapter =
    options.adapter ??
    ({
      kind: 'red',
      getFlows: () => Promise.resolve({ rev: 'rev-1', flows: [{ id: 'tab-1', type: 'tab' }] }),
      getFlow: (id: string) =>
        Promise.resolve({
          rev: 'rev-1',
          flow: { ...flow, id, nodes: flow.nodes?.map(n => ({ ...n })) },
        }),
      updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
    } as FlowAdapter);

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir: options.userDir,
      httpAdminRoot: '/',
      adminAuth: { type: 'credentials' },
      aiAccess: { defaultDeploymentType: 'nodes', defaultLinkTtlSeconds: 14_400 },
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

  registerRoutes(RED, { linkStore, flowAdapter: adapter });
  return { app, linkStore };
}

describe('GET /mcp/a/<token> access links', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-get-link-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('defaults access-link TTL to 4 hours', () => {
    expect(DEFAULT_ACCESS_LINK_TTL_SECONDS).toBe(14_400);
    const store = new AccessLinkStore({ now: () => 1_000_000 });
    const created = store.create();
    expect(created.expiresAt).toBe(new Date(1_000_000 + 14_400_000).toISOString());
  });

  it('create link returns absolute url under /mcp/a/<token>', async () => {
    const { app } = createApp({ userDir });
    // Bypass admin gate by hitting store via a thin wrapper: use registerRoutes
    // admin links require admin session — simulate by calling store+handler via API
    // after mocking needsPermission to set user.
    const app2 = express();
    app2.use(express.json());
    const linkStore = new AccessLinkStore({ defaultTtlSeconds: 14_400 });
    const RED: NodeRedPluginAPI = {
      settings: {
        userDir,
        httpAdminRoot: '/',
        adminAuth: { type: 'credentials' },
        aiAccess: { defaultLinkTtlSeconds: 14_400 },
      },
      httpAdmin: app2,
      auth: {
        needsPermission() {
          return (req: Request, _res: Response, next: NextFunction) => {
            (req as Request & { user?: { username: string; permissions: string } }).user = {
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
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    registerRoutes(RED, {
      linkStore,
      flowAdapter: {
        kind: 'red',
        getFlows: () => Promise.resolve({ rev: 'r', flows: [] }),
        getFlow: () => Promise.resolve({ rev: 'r', flow: { id: 't', type: 'tab', nodes: [] } }),
        updateFlow: () => Promise.resolve({ rev: 'r2' }),
      },
    });

    const created = await request(app2)
      .post('/mcp/api/v1/links')
      .set('Host', 'nodered.example:1880')
      .send({ label: 'chat-ai' });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^aia_/);
    expect(created.body.url).toBe(`http://nodered.example:1880/mcp/a/${created.body.token}`);
    // silence unused
    void app;
  });

  it('negotiates the markdown guide Content-Type (text/plain unless text/markdown is asked for)', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'negotiate' });
    const url = `/mcp/a/${link.token}`;
    const cases: [string | undefined, string][] = [
      [undefined, 'text/plain; charset=utf-8'],
      ['*/*', 'text/plain; charset=utf-8'],
      [
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'text/plain; charset=utf-8',
      ],
      ['text/markdown', 'text/markdown; charset=utf-8'],
      ['text/markdown, text/plain;q=0.5', 'text/markdown; charset=utf-8'],
    ];
    for (const [accept, expected] of cases) {
      const req = request(app).get(url).set('X-Test-Raw-Accept', '1');
      const res = accept === undefined ? await req : await req.set('Accept', accept);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(expected);
      expect(res.headers.vary).toMatch(/Accept/);
      expect(res.text).toMatch(/GET \.\/flows/);
    }
  });

  it('supports ?format=md for the guide', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'fmt-md' });
    const res = await request(app)
      .get(`/mcp/a/${link.token}?format=md`)
      .set('X-Test-Raw-Accept', '1');
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
  });

  it('negotiates JSON success and error bodies (text/plain unless JSON is asked for)', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'fmt-json' });
    const raw = (path: string) => request(app).get(path).set('X-Test-Raw-Accept', '1');

    const plain = await raw(`/mcp/a/${link.token}/status`);
    expect(plain.status).toBe(200);
    expect(plain.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(plain.headers.vary).toMatch(/Accept/);
    expect(JSON.parse(plain.text).ok).toBe(true);

    const star = await raw(`/mcp/a/${link.token}/status`).set('Accept', '*/*');
    expect(star.headers['content-type']).toBe('text/plain; charset=utf-8');

    const browser = await raw(`/mcp/a/${link.token}/status`).set(
      'Accept',
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    );
    expect(browser.headers['content-type']).toBe('text/plain; charset=utf-8');

    const accept = await raw(`/mcp/a/${link.token}/status`).set('Accept', 'application/json');
    expect(accept.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(accept.body.ok).toBe(true);

    const fmt = await raw(`/mcp/a/${link.token}/status?format=json`);
    expect(fmt.headers['content-type']).toBe('application/json; charset=utf-8');

    // Errors keep their status codes and bodies; only the Content-Type changes.
    const notFound = await raw(`/mcp/a/${link.token}/no-such-route`);
    expect(notFound.status).toBe(404);
    expect(notFound.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(JSON.parse(notFound.text).code).toBe('not_found');

    const badToken = await raw('/mcp/a/aia_unknown_token_value_xxxxxxxxxxxxxxxxxxxxx/status');
    expect(badToken.status).toBe(401);
    expect(badToken.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(typeof JSON.parse(badToken.text).code).toBe('string');

    const badTokenJson = await raw(
      '/mcp/a/aia_unknown_token_value_xxxxxxxxxxxxxxxxxxxxx/status?format=json'
    );
    expect(badTokenJson.status).toBe(401);
    expect(badTokenJson.headers['content-type']).toBe('application/json; charset=utf-8');

    const mint = await request(app)
      .post(`/mcp/a/${link.token}/links`)
      .set('X-Test-Raw-Accept', '1');
    expect(mint.status).toBe(403);
    expect(mint.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('keeps ?format=summary|full working on the GET-link diff alongside format=json', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'fmt-diff' });
    const res = await request(app)
      .get(`/mcp/a/${link.token}/proposals/prop-missing/diff?format=json`)
      .set('X-Test-Raw-Accept', '1');
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.body.code).not.toBe('invalid_diff_format');
  });

  it('serves markdown docs and JSON status/flows with Cache-Control: no-store', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'docs' });

    const docs = await request(app).get(`/mcp/a/${link.token}`);
    expect(docs.status).toBe(200);
    expect(docs.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(docs.headers.vary).toMatch(/Accept/);
    expect(docs.headers['cache-control']).toMatch(/no-store/);
    expect(docs.text).toMatch(/human owner[\s*]*must approve/i);
    expect(docs.text).toMatch(/\./);
    expect(docs.text).toMatch(/GET \.\/flows/);
    expect(docs.text).toMatch(/token_expired/);
    expect(docs.text).toMatch(/access_link_invalid/);
    expect(docs.text).toMatch(/minutesRemaining/);
    expect(docs.text).toMatch(/get_link/);
    expect(docs.text).toMatch(/not.*REST or MCP Bearer|separate \*\*rest\*\* or \*\*mcp\*\*/i);
    expect(docs.text).toMatch(/rest-token|rest\*\* kind/i);
    expect(docs.text).toMatch(/mcp-token|mcp\*\* kind/i);
    const alsoIdx = docs.text.indexOf('## Also available');
    const workflowIdx = docs.text.indexOf('## Step-by-step workflow');
    expect(alsoIdx).toBeGreaterThan(0);
    expect(alsoIdx).toBeLessThan(workflowIdx);
    expect(docs.text).toMatch(/YOUR-NODE-RED\/mcp\/rpc/);
    expect(docs.text).toMatch(/\.\/node-types/);
    expect(docs.text).toMatch(/palette\/search/);
    expect(docs.text).toMatch(/Manage palette/);
    expect(docs.headers['x-content-type-options']).toBe('nosniff');
    // Path token must not be reflected into the docs body (XSS / sniffing).
    expect(docs.text).not.toContain(link.token);

    const status = await request(app).get(`/mcp/a/${link.token}/status`);
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toMatch(/no-store/);
    expect(status.body.caller.kind).toBe('access-link');
    expect(status.body.caller.label).toBe('docs');
    expect(status.body.caller.tokenKind).toBe('get_link');
    expect(status.body.caller.baseUrls.api).toBeUndefined();
    expect(status.body.caller.baseUrls.rpc).toBeUndefined();
    expect(status.body).not.toHaveProperty('storageDir');

    const flows = await request(app).get(`/mcp/a/${link.token}/flows`);
    expect(flows.status).toBe(200);
    expect(flows.body.rev).toBe('rev-1');

    const one = await request(app).get(`/mcp/a/${link.token}/flows/tab-1`);
    expect(one.status).toBe(200);
    expect(one.body.flow).toMatchObject({ id: 'tab-1', type: 'tab' });
    expect(one.body.rev).toBe('rev-1');
  });

  it('rejects invalid token with access_link_invalid JSON', async () => {
    const { app } = createApp({ userDir });
    const res = await request(app).get('/mcp/a/aia_not-real/status');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('access_link_invalid');
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('GET propose applies set.<prop> and creates a pending proposal', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'propose' });

    const res = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&node=n1&set.name=Hello&summary=rename&include=payload`
    );
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.proposal).toMatchObject({
      type: 'replace_flow',
      status: 'pending',
      expectedRev: 'rev-1',
      payload: { flowId: 'tab-1' },
      changeSummary: expect.any(String),
    });
    const renamed = res.body.proposal.payload.flow.nodes.find((n: { id: string }) => n.id === 'n1');
    expect(renamed.name).toBe('Hello');

    const list = await request(app).get(`/mcp/a/${link.token}/proposals`);
    expect(list.body.proposals).toHaveLength(1);

    const got = await request(app).get(`/mcp/a/${link.token}/proposals/${res.body.proposal.id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(res.body.proposal.id);

    const diff = await request(app).get(
      `/mcp/a/${link.token}/proposals/${res.body.proposal.id}/diff`
    );
    expect(diff.status).toBe(200);
  });

  it('GET propose with stale rev returns version_mismatch', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'stale' });
    const res = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=old&node=n1&set.name=X`
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('version_mismatch');
  });

  it('rejects oversized GET propose URLs with url_too_long guidance', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'big' });
    const huge = 'x'.repeat(MAX_GET_ACCESS_URL_BYTES);
    const res = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&node=n1&set.name=${huge}`
    );
    expect(res.status).toBe(414);
    expect(res.body.code).toBe('url_too_long');
    expect(String(res.body.hint)).toMatch(/draft/i);
  });

  it('chunked draft upload assembles HTML and creates a proposal', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'html-draft' });

    // Keep under the per-token rate limit while still exercising chunking.
    const html = `<!DOCTYPE html><html><body>${'<!-- pad -->'.repeat(40)}<h1>Hello</h1></body></html>`;
    const htmlBuf = Buffer.from(html, 'utf8');
    const sha256 = createHash('sha256').update(htmlBuf).digest('hex');

    const created = await request(app).get(
      `/mcp/a/${link.token}/draft/new?flow=tab-1&rev=rev-1&node=n2&field=template&summary=html`
    );
    expect(created.status).toBe(201);
    const draftId = created.body.draftId as string;
    expect(draftId).toBeTruthy();

    const chunkSize = 120;
    const chunks: Buffer[] = [];
    for (let i = 0; i < htmlBuf.length; i += chunkSize) {
      chunks.push(htmlBuf.subarray(i, i + chunkSize));
    }

    for (let seq = 0; seq < chunks.length; seq += 1) {
      const data = chunks[seq]!.toString('base64url');
      const appended = await request(app).get(
        `/mcp/a/${link.token}/draft/${draftId}/append?seq=${seq}&data=${data}`
      );
      expect(appended.status).toBe(200);
      expect(appended.body.ok).toBe(true);
    }
    // Idempotent re-append of seq 0
    const again = await request(app).get(
      `/mcp/a/${link.token}/draft/${draftId}/append?seq=0&data=${chunks[0]!.toString('base64url')}`
    );
    expect(again.status).toBe(200);

    const submitted = await request(app).get(
      `/mcp/a/${link.token}/draft/${draftId}/submit?sha256=${sha256}&include=payload`
    );
    expect(submitted.status).toBe(201);
    expect(submitted.body.ok).toBe(true);
    expect(submitted.body.proposal.status).toBe('pending');
    const tpl = submitted.body.proposal.payload.flow.nodes.find(
      (n: { id: string }) => n.id === 'n2'
    );
    expect(tpl.template).toBe(html);
  });

  it('redacts access-link tokens from paths', () => {
    expect(redactAccessLinkTokenInPath('/mcp/a/aia_secret123/status')).toBe(
      '/mcp/a/<redacted>/status'
    );
  });

  it('unknown paths under /mcp/a return JSON not_found without echoing the token', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: '404' });
    const res = await request(app).get(`/mcp/a/${link.token}/whatever`);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body).toEqual({ error: 'Not found', code: 'not_found' });
    expect(JSON.stringify(res.body)).not.toContain(link.token);
    expect(res.text).not.toContain(link.token);
    expect(res.text).not.toMatch(/Cannot GET/i);

    const bogus = await request(app).get('/mcp/a/aia_not-a-real-token/nope');
    expect(bogus.status).toBe(404);
    expect(bogus.body.code).toBe('not_found');
    expect(bogus.text).not.toContain('aia_not-a-real-token');
  });

  it('draft append reports decoded totalBytes vs maxBytes', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'bytes' });
    const created = await request(app).get(
      `/mcp/a/${link.token}/draft/new?flow=tab-1&rev=rev-1&node=n2&field=template`
    );
    expect(created.status).toBe(201);
    const draftId = created.body.draftId as string;
    const raw = Buffer.from('hello-world-bytes', 'utf8');
    const data = raw.toString('base64url');
    expect(Buffer.byteLength(data, 'utf8')).toBeGreaterThan(raw.byteLength);

    const appended = await request(app).get(
      `/mcp/a/${link.token}/draft/${draftId}/append?seq=0&data=${data}`
    );
    expect(appended.status).toBe(200);
    expect(appended.body.totalBytes).toBe(raw.byteLength);
    expect(appended.body.maxBytes).toBeGreaterThan(0);
    expect(String(appended.body.hint)).toMatch(/No gaps so far; call submit/i);
    expect(String(appended.body.hint)).not.toMatch(/All seqs through max are present/i);
  });

  it('draft/new rejects nonexistent node/field before upload', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'validate' });

    const badNode = await request(app).get(
      `/mcp/a/${link.token}/draft/new?flow=tab-1&rev=rev-1&node=missing&field=template`
    );
    expect(badNode.status).toBe(404);
    expect(badNode.body.code).toBe('node_not_found');
    expect(String(badNode.body.hint ?? '')).not.toMatch(/rev is stale/i);

    const badField = await request(app).get(
      `/mcp/a/${link.token}/draft/new?flow=tab-1&rev=rev-1&node=n2&field=nope`
    );
    expect(badField.status).toBe(404);
    expect(badField.body.code).toBe('field_not_found');

    // mode=json may add nodes — skip live node/field validation
    const jsonMode = await request(app).get(
      `/mcp/a/${link.token}/draft/new?flow=tab-1&rev=rev-1&mode=json`
    );
    expect(jsonMode.status).toBe(201);
    expect(jsonMode.body.mode).toBe('json');
  });

  it('chunk_conflict hint is specific (not generic stale-rev)', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'conflict' });
    const created = await request(app).get(
      `/mcp/a/${link.token}/draft/new?flow=tab-1&rev=rev-1&node=n2&field=template`
    );
    const draftId = created.body.draftId as string;
    const a = Buffer.from('aaa', 'utf8').toString('base64url');
    const b = Buffer.from('bbb', 'utf8').toString('base64url');
    await request(app).get(`/mcp/a/${link.token}/draft/${draftId}/append?seq=0&data=${a}`);
    const conflict = await request(app).get(
      `/mcp/a/${link.token}/draft/${draftId}/append?seq=0&data=${b}`
    );
    expect(conflict.status).toBe(400);
    expect(conflict.body.code).toBe('chunk_conflict');
    expect(String(conflict.body.hint)).toMatch(/same data|new draft/i);
    expect(String(conflict.body.hint)).not.toMatch(/rev is stale|re-read flows if rev/i);
  });

  it('propose patch can add and remove nodes via op', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'ops' });
    const patch = {
      nodes: [
        { op: 'add', node: { id: 'n9', type: 'debug', z: 'tab-1', name: 'out', wires: [[]] } },
        { op: 'remove', id: 'n1' },
        { op: 'set', id: 'n2', set: { name: 'Tpl2' } },
      ],
    };
    const encoded = Buffer.from(JSON.stringify(patch), 'utf8').toString('base64url');
    const res = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&patch=${encoded}&include=payload`
    );
    expect(res.status).toBe(201);
    const nodes = res.body.proposal.payload.flow.nodes as { id: string; name?: string }[];
    expect(nodes.some(n => n.id === 'n9')).toBe(true);
    expect(nodes.some(n => n.id === 'n1')).toBe(false);
    expect(nodes.find(n => n.id === 'n2')?.name).toBe('Tpl2');

    const docs = await request(app).get(`/mcp/a/${link.token}`);
    expect(docs.text).toMatch(/op.: .add/);
    expect(docs.text).toMatch(/4–5 KB|4-5 KB|~4/);
    expect(docs.text).toMatch(/mode=json/);
  });

  it('propose node_not_found hint is not the generic stale-rev message', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'hints' });
    const res = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&node=missing&set.name=X`
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('node_not_found');
    expect(String(res.body.hint ?? '')).toMatch(/flows/i);
    expect(String(res.body.hint ?? '')).not.toMatch(/re-read flows if rev is stale/i);
  });

  it('GET-link surface has no POST /links mint; docs and OpenAPI say cannot mint', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ kind: 'get_link', label: 'no-mint' });
    const before = linkStore.list().length;

    const postLinks = await request(app)
      .post(`/mcp/a/${link.token}/links`)
      .send({ label: 'should-fail', kind: 'rest' });
    expect(postLinks.status).toBe(403);
    expect(postLinks.headers['content-type']).toMatch(/json/);
    expect(postLinks.headers['cache-control']).toMatch(/no-store/);
    expect(postLinks.body).toMatchObject({
      code: 'link_create_not_supported',
      error: 'GET access links cannot create tokens',
    });
    expect(String(postLinks.body.hint)).toMatch(/POST \/mcp\/api\/v1\/links/);
    expect(JSON.stringify(postLinks.body)).not.toContain(link.token);

    const postLinksId = await request(app)
      .post(`/mcp/a/${link.token}/links/anything`)
      .send({ label: 'nope' });
    expect(postLinksId.status).toBe(403);
    expect(postLinksId.body.code).toBe('link_create_not_supported');

    const getLinks = await request(app).get(`/mcp/a/${link.token}/links`);
    expect(getLinks.status).toBe(403);
    expect(getLinks.body.code).toBe('link_create_not_supported');

    const deleteLinks = await request(app).delete(`/mcp/a/${link.token}/links/${link.id}`);
    expect(deleteLinks.status).toBe(403);
    expect(deleteLinks.body.code).toBe('link_create_not_supported');

    expect(linkStore.list()).toHaveLength(before);

    const docs = await request(app).get(`/mcp/a/${link.token}`);
    expect(docs.status).toBe(200);
    expect(docs.text).toMatch(/cannot.*create access tokens|cannot mint tokens/i);
    expect(docs.text).toMatch(/link_create_not_supported/);
    expect(docs.text).toMatch(/POST \/mcp\/api\/v1\/links/);
    expect(docs.text).toMatch(/no[\s*`]*POST \.\/links/i);
    expect(docs.text).not.toMatch(/\|\s*`POST \.\/links/i);

    const openapi = await request(app).get('/mcp/api/v1/openapi.yaml');
    expect(openapi.status).toBe(200);
    expect(openapi.text).toMatch(/AccessLinkKind/);
    expect(openapi.text).toMatch(/enum:\s*\[get_link,\s*rest,\s*mcp\]/);
    expect(openapi.text).toMatch(/CreateLinkRequest/);
    expect(openapi.text).toMatch(/wrong_token_kind/);
    expect(openapi.text).toMatch(/invalid_link_kind/);
    expect(openapi.text).toMatch(/never mints tokens|no link-create operation/i);
    expect(openapi.text).toMatch(/link_create_not_supported/);
    // OpenAPI must not advertise a mint under the get-link path.
    expect(openapi.text).not.toMatch(/\/mcp\/a\/\{token\}\/links/);
    expect(openapi.text).not.toMatch(/operationId:\s*createLinkUnderGetAccess/);

    const discovery = await request(app).get('/mcp/api/v1');
    expect(discovery.status).toBe(200);
    expect(discovery.body.getLink).toMatchObject({ canMintTokens: false });
    expect(discovery.body.auth.mint).toMatchObject({
      path: '/links',
      method: 'POST',
      auth: 'admin',
    });
    expect(discovery.body.auth.tokenKinds).toEqual(['get_link', 'rest', 'mcp']);
    expect(String(discovery.body.auth.description)).toMatch(/cannot create tokens/i);
    const mintUnderGet = (discovery.body.endpoints as { method: string; path: string }[]).some(
      e => e.path.includes('/mcp/a') && e.path.includes('/links')
    );
    expect(mintUnderGet).toBe(false);
  });
});
