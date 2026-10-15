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

  it('serves markdown docs and JSON status/flows with Cache-Control: no-store', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'docs' });

    const docs = await request(app).get(`/mcp/a/${link.token}`);
    expect(docs.status).toBe(200);
    expect(docs.headers['content-type']).toMatch(/markdown/);
    expect(docs.headers['cache-control']).toMatch(/no-store/);
    expect(docs.text).toMatch(/human owner[\s*]*must approve/i);
    expect(docs.text).toMatch(`/mcp/a/${link.token}/flows`);
    expect(docs.text).toMatch(/access_link_invalid/);

    const status = await request(app).get(`/mcp/a/${link.token}/status`);
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toMatch(/no-store/);
    expect(status.body.caller.kind).toBe('access-link');
    expect(status.body.caller.label).toBe('docs');

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
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&node=n1&set.name=Hello&summary=rename`
    );
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.proposal).toMatchObject({
      type: 'replace_flow',
      status: 'pending',
      expectedRev: 'rev-1',
      payload: { flowId: 'tab-1' },
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

    // Keep under the per-link rate limit (60/min) while still exercising chunking.
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
      `/mcp/a/${link.token}/draft/${draftId}/submit?sha256=${sha256}`
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
});
