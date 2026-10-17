/**
 * GET-link HTML default representation, linkify, and hardening headers.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import {
  chooseGetLinkRepresentation,
  getLinkBaseHref,
  linkifyEscaped,
  escapeHtml,
  renderGetLinkHtml,
} from '../../src/plugin/content-type.js';
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
    label: 'Main <script>alert("flow")</script>',
    nodes: [
      { id: 'n1', type: 'inject', z: 'tab-1', name: 'Old' },
      { id: 'nx', type: 'inject', z: 'tab-1', name: '<img src=x onerror=alert(1)>' },
      {
        id: 'nf',
        type: 'function',
        z: 'tab-1',
        name: 'fn',
        func: 'return "</pre><script>alert(2)</script>";',
      },
      { id: 'n2', type: 'template', z: 'tab-1', name: 'Tpl', template: '<p>hi</p>' },
    ],
  };

  const adapter: FlowAdapter =
    options.adapter ??
    ({
      kind: 'red',
      getFlows: () =>
        Promise.resolve({
          rev: 'rev-1',
          flows: [{ ...flow, nodes: undefined }, ...(flow.nodes ?? [])],
        }),
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

const HTML = 'text/html; charset=utf-8';
const raw = (app: Express, path: string) =>
  request(app).get(path).set('X-Test-Raw-Accept', '1').set('Host', 'nr.example');

function expectHardening(res: request.Response, html: boolean): void {
  expect(res.headers['cache-control']).toMatch(/no-store/);
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers.vary).toMatch(/Accept/);
  if (html) {
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
    );
  } else {
    expect(res.headers['content-security-policy']).toBeUndefined();
  }
}

/** Extract and unescape the <pre> body of an HTML response. */
function preText(html: string): string {
  const m = /<pre>([\s\S]*)<\/pre>/.exec(html);
  return (m?.[1] ?? '')
    .replace(/<a href="[^"]*">([^<]*)<\/a>/g, '$1')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

describe('GET-link HTML representation', () => {
  let userDir: string;
  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-get-link-html-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(userDir, { recursive: true, force: true });
  });

  it('defaults every route (and errors) to HTML with the same data', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'html' });
    const t = `/mcp/a/${link.token}`;
    const routes: [string, number][] = [
      [t, 200],
      [`${t}/status`, 200],
      [`${t}/flows`, 200],
      [`${t}/flows/tab-1`, 200],
      [`${t}/flows/tab-1?summary=1`, 200],
      [`${t}/nodes/n1`, 200],
      [`${t}/search?q=Old`, 200],
      [`${t}/proposals`, 200],
      [`${t}/no-such-route`, 404],
      [`${t}/nodes/missing`, 404],
      [`${t}/search`, 400],
      ['/mcp/a/aia_unknown_token_value_xxxxxxxxxxxxxxxxxxxxx/status', 401],
    ];
    for (const [path, status] of routes) {
      const html = await raw(app, path);
      expect(html.status, path).toBe(status);
      expect(html.headers['content-type'], path).toBe(HTML);
      expect(html.text.startsWith('<!doctype html>'), path).toBe(true);
      expect(html.text).toContain('<meta charset="utf-8">');
      expect(html.text).toContain('<title>');
      expect(html.text).not.toMatch(/<script/i);
      expectHardening(html, true);

      const native = await raw(app, path).set('Accept', 'application/json, text/markdown');
      expect(native.status, path).toBe(status);
      if (native.headers['content-type'].startsWith('application/json')) {
        expect(JSON.parse(preText(html.text))).toEqual(native.body);
      } else {
        expect(preText(html.text)).toBe(native.text);
      }
      expectHardening(native, false);
    }
  });

  it('serves the HTML default for an expired link (401 token_expired)', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'exp', ttlSeconds: 60 });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    const res = await raw(app, `/mcp/a/${link.token}/status`);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toBe(HTML);
    expect(JSON.parse(preText(res.text)).code).toBe('token_expired');
  });

  it('keeps explicit formats exactly as before', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'fmt' });
    const t = `/mcp/a/${link.token}`;
    const cases: [string, string | undefined, string][] = [
      [t, 'text/markdown', 'text/markdown; charset=utf-8'],
      [`${t}?format=md`, undefined, 'text/markdown; charset=utf-8'],
      [t, 'text/plain', 'text/plain; charset=utf-8'],
      [`${t}/status`, 'application/json', 'application/json; charset=utf-8'],
      [`${t}/status?format=json`, undefined, 'application/json; charset=utf-8'],
      [`${t}/status?format=json`, 'text/html', 'application/json; charset=utf-8'],
      [`${t}/status`, 'text/plain', 'text/plain; charset=utf-8'],
      [`${t}/no-such-route`, 'application/json', 'application/json; charset=utf-8'],
      [t, '*/*', HTML],
      [t, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', HTML],
      [`${t}/status`, 'text/html, application/json;q=0.5', HTML],
    ];
    for (const [path, accept, expected] of cases) {
      const req = raw(app, path);
      const res = accept ? await req.set('Accept', accept) : await req;
      expect(res.headers['content-type'], `${path} ${accept}`).toBe(expected);
      if (expected !== HTML) expect(res.text.startsWith('<!doctype')).toBe(false);
    }
    const plain = await raw(app, `${t}/status`).set('Accept', 'text/plain');
    expect(JSON.parse(plain.text).ok).toBe(true);
  });

  it('escapes XSS payloads from flow labels, node names, function code, and proposal titles', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'xss' });
    const t = `/mcp/a/${link.token}`;
    const prop = await request(app).get(
      `${t}/propose?flow=tab-1&rev=rev-1&node=n1&set.name=x&summary=${encodeURIComponent(
        '<svg onload=alert(3)>'
      )}`
    );
    expect(prop.status).toBe(201);
    for (const path of [
      `${t}/flows`,
      `${t}/flows/tab-1`,
      `${t}/nodes/nf`,
      `${t}/nodes/nx`,
      `${t}/proposals`,
    ]) {
      const res = await raw(app, path);
      expect(res.headers['content-type']).toBe(HTML);
      expect(res.text).not.toMatch(/<script|<img|<svg|<\/pre><script/i);
    }
    const id = prop.body.proposal.id as string;
    for (const [path, status] of [
      [`${t}/proposals/${id}`, 200],
      [`${t}/proposals/${id}/diff`, 200],
      [`${t}/proposals/${id}/diff?format=full`, 200],
      [`${t}/proposals/${id}/withdraw`, 400],
      [`${t}/nodes/nf/field/func`, 200],
      [`${t}/node-types`, 200],
    ] as const) {
      const res = await raw(app, path);
      expect(res.status, path).toBe(status);
      expect(res.headers['content-type'], path).toBe(HTML);
      expect(res.text).not.toMatch(/<script|<img|<svg/i);
    }
    const flowHtml = (await raw(app, `${t}/flows/tab-1`)).text;
    expect(flowHtml).toContain('&lt;script&gt;alert(');
    expect(flowHtml).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect((await raw(app, `${t}/nodes/nf`)).text).toContain('&lt;/pre&gt;&lt;script&gt;');
    expect((await raw(app, `${t}/proposals`)).text).toContain('&lt;svg onload=alert(3)&gt;');
  });

  it('linkifies relative guide links under the token base and they resolve', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'links' });
    const t = `/mcp/a/${link.token}`;
    const res = await raw(app, t);
    expect(res.text).toContain(`<base href="${t}/">`);
    const hrefs = [...res.text.matchAll(/<a href="([^"]+)">/g)].map(m => m[1] as string);
    expect(hrefs).toContain('./status');
    expect(hrefs).toContain('./flows');
    for (const href of hrefs) {
      expect(href).toMatch(/^\.\/[A-Za-z0-9._~\-/]+(\?[A-Za-z0-9._~\-=&%]+)?$/);
      expect(href).not.toContain('..');
    }
    // Relative resolution against the <base> stays under the token path.
    const resolved = new URL('./status', `http://h${t}/`).pathname;
    expect(resolved).toBe(`${t}/status`);
    const status = await raw(app, resolved);
    expect(status.status).toBe(200);
  });
});

describe('linkify / escaping helpers', () => {
  it('rejects unsafe link shapes', () => {
    for (const bad of [
      'javascript:alert(1)',
      '//evil.example/x',
      'http://evil.example/x',
      'https://evil.example/./x',
      '../status',
      './../status',
      './a/../../b',
    ]) {
      expect(linkifyEscaped(escapeHtml(bad))).not.toContain('<a ');
    }
    const attr = linkifyEscaped(escapeHtml('./foo"onmouseover=alert(1)'));
    expect(attr).toBe('<a href="./foo">./foo</a>&quot;onmouseover=alert(1)');
    expect(linkifyEscaped('see ./status.')).toBe('see <a href="./status">./status</a>.');
    expect(linkifyEscaped('GET ./flows?summary=1 now')).toContain(
      '<a href="./flows?summary=1">./flows?summary=1</a>'
    );
  });

  it('renders a minimal escaped document', () => {
    const html = renderGetLinkHtml('<b>&"\'</b>');
    expect(html).toContain('<pre>&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;</pre>');
    expect(html).not.toContain('<base');
  });

  it('base href only for safe token paths', () => {
    expect(getLinkBaseHref('/mcp/a/aia_abc-1/status?x=1')).toBe('/mcp/a/aia_abc-1/');
    expect(getLinkBaseHref('/admin/mcp/a/aia_abc')).toBe('/admin/mcp/a/aia_abc/');
    expect(getLinkBaseHref('/mcp/a/aia"x/status')).toBeUndefined();
  });

  it('chooses representation from Accept and format', () => {
    const mk = (accept?: string, format?: string) => {
      const app = express();
      let out = '';
      app.get('/x', (req, res) => {
        out = chooseGetLinkRepresentation(req);
        res.end();
      });
      const r = request(app).get(`/x${format ? `?format=${format}` : ''}`);
      return (accept ? r.set('Accept', accept) : r).then(() => out);
    };
    return Promise.all([
      mk().then(v => expect(v).toBe('html')),
      mk('*/*').then(v => expect(v).toBe('html')),
      mk('application/json').then(v => expect(v).toBe('native')),
      mk('text/markdown').then(v => expect(v).toBe('native')),
      mk('text/plain').then(v => expect(v).toBe('plain')),
      mk('text/html', 'json').then(v => expect(v).toBe('native')),
    ]);
  });
});
