/**
 * Dashboard Settings + OAuth tabs (moved from the editor sidebar in 0.2.0-beta.3):
 * routing (/ai-access, /mcp browser redirect), markup, and client-side escaping.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeHttpAdminRoot } from '../../src/plugin/auth.js';
import { acceptedMediaTypes, registerRoutes } from '../../src/plugin/index.js';
import { renderConsentPage } from '../../src/plugin/oauth-consent-page.js';
import { pageClientSettingsScript } from '../../src/plugin/page-client-settings.js';
import { pageClientScript } from '../../src/plugin/page-client.js';
import { renderMcpPage } from '../../src/plugin/page.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';

function appFor(userDir: string, httpAdminRoot?: string) {
  const app = express();
  app.use(express.json());
  const RED = {
    settings: {
      userDir,
      adminAuth: { type: 'credentials' },
      ...(httpAdminRoot ? { httpAdminRoot } : {}),
    },
    httpAdmin: app,
    httpNode: express(),
    auth: { needsPermission: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    events: { on: vi.fn() },
    plugins: { registerPlugin: vi.fn() },
  } as unknown as NodeRedPluginAPI;
  registerRoutes(RED);
  return app;
}

describe('dashboard routing', () => {
  let userDir: string;
  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-dash-'));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('serves the dashboard at /ai-access and redirects browser GET /mcp there', async () => {
    const app = appFor(userDir);
    const page = await request(app).get('/ai-access');
    expect(page.status).toBe(200);
    expect(page.type).toBe('text/html');
    for (const tab of ['status', 'settings', 'links', 'oauth', 'proposals', 'logs']) {
      expect(page.text).toContain(`data-tab="${tab}"`);
    }
    const redirect = await request(app)
      .get('/mcp')
      .set('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('/ai-access');
    const sse = await request(app).get('/mcp').set('Accept', 'text/event-stream');
    expect(sse.status).not.toBe(302);
  });

  it('respects httpAdminRoot for the redirect target', async () => {
    const app = appFor(userDir, '/admin');
    const redirect = await request(app).get('/mcp').set('Accept', 'text/html');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('/admin/ai-access');
  });

  it.each([
    [undefined, true],
    ['*/*', true],
    ['text/html', true],
    ['text/html,application/xhtml+xml,*/*;q=0.8', true],
    ['text/html, text/event-stream', true],
    ['text/event-stream, text/html;q=0.5', true],
    ['text/event-stream', false],
    ['application/json, text/event-stream', false],
    ['text/event-stream, text/html;q=0', false],
    ['text/html;q=0.0, text/event-stream', false],
    ['TEXT/EVENT-STREAM', false],
    ['text/event-stream;q=0, text/html', true],
  ] as const)(
    'GET /mcp Accept=%s redirect=%s (with and without Bearer)',
    async (accept, redirects) => {
      const app = appFor(userDir);
      for (const bearer of [undefined, 'Bearer aia_invalid', 'Bearer not-a-token']) {
        let req = request(app).get('/mcp');
        if (accept) req = req.set('Accept', accept);
        if (bearer) req = req.set('Authorization', bearer);
        const res = await req;
        const label = `${String(accept)} / ${String(bearer)}`;
        if (redirects) {
          expect(res.status, label).toBe(302);
          expect(res.headers.location, label).toBe('/ai-access');
        } else {
          expect(res.status, label).not.toBe(302);
          expect(res.headers.location, label).toBeUndefined();
          expect([401, 403, 405], label).toContain(res.status);
        }
      }
    }
  );

  it('HEAD follows GET negotiation; OPTIONS never redirects', async () => {
    const app = appFor(userDir);
    const head = await request(app).head('/mcp').set('Accept', 'text/html');
    expect(head.status).toBe(302);
    expect(head.headers.location).toBe('/ai-access');
    const headSse = await request(app).head('/mcp').set('Accept', 'text/event-stream');
    expect(headSse.status).not.toBe(302);
    const opts = await request(app)
      .options('/mcp')
      .set('Origin', 'https://client.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(opts.status).not.toBe(302);
    expect(opts.headers.location).toBeUndefined();
  });

  it.each([
    ['/admin', '/admin/ai-access'],
    ['/admin/', '/admin/ai-access'],
    ['admin', '/admin/ai-access'],
    ['//evil.com', '/evil.com/ai-access'],
    ['///evil.com//x/', '/evil.com/x/ai-access'],
  ])(
    'redirect target for httpAdminRoot %s is %s (never protocol-relative)',
    async (root, target) => {
      const app = appFor(userDir, root);
      const res = await request(app).get('/mcp').set('Accept', 'text/html');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(target);
      expect(res.headers.location!.startsWith('//')).toBe(false);
    }
  );

  it('renders number + unit inputs and lock badges without leaking config into HTML', () => {
    const html = renderMcpPage({
      apiBase: '/mcp/api/v1',
      editorRoot: '/',
      authTokenKey: 'auth-tokens',
      dashboardPath: '/"><script>x</script>',
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toMatch(
      /id="set-rate-window"[^>]*class="num"[\s\S]*?<span class="unit">ms<\/span>/
    );
    expect(html).toMatch(/id="oauth-access-ttl-unit"/);
    expect(html).not.toContain('prefers-color-scheme');
    expect(html).toContain('color-scheme: light');
    expect(html).not.toMatch(/<link[^>]+href=|<script[^>]+src=|@import|https?:\/\/fonts/);
  });
});

interface FakeEl {
  id: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  innerHTML: string;
  className: string;
  listeners: Record<string, (() => void)[]>;
  addEventListener(ev: string, fn: () => void): void;
  querySelectorAll(sel: string): FakeEl[];
  children: FakeEl[];
  attrs: Record<string, string>;
  tagName: string;
  readonly firstChild: FakeEl | null;
  appendChild(child: FakeEl): FakeEl;
  removeChild(child: FakeEl): FakeEl;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  [extra: string]: unknown;
}

function makeEl(id: string, tagName = 'div'): FakeEl {
  return {
    id,
    tagName,
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    textContent: '',
    innerHTML: '',
    className: '',
    listeners: {},
    children: [],
    attrs: {},
    get firstChild() {
      return this.children[0] ?? null;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter(c => c !== child);
      return child;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    addEventListener(ev, fn) {
      (this.listeners[ev] ??= []).push(fn);
    },
    querySelectorAll() {
      return [];
    },
  };
}

function fakeDom() {
  const els = new Map<string, FakeEl>();
  const get = (id: string): FakeEl => {
    let el = els.get(id);
    if (!el) {
      el = makeEl(id);
      if (
        /^(set-(ttl|proposal-ttl|max-links|rate-ip|rate-token)|oauth-(access-ttl|refresh-ttl|dcr-cap))$/.test(
          id
        )
      )
        el.min = '1';
      if (id === 'set-proposal-ttl') el.max = '365';
      if (id === 'set-rate-window') el.min = '100';
      els.set(id, el);
    }
    return el;
  };
  return { get };
}

function loadSettingsClient(responses: Record<string, unknown>, editorRoot = '/') {
  const dom = fakeDom();
  const calls: { path: string; options?: { method?: string; body?: string } }[] = [];
  const confirm: { opts?: { onConfirm?: () => unknown } } = {};
  const toasts: { message: string; ok: boolean }[] = [];
  const ctx = {
    dom,
    toasts,
    api: async (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, ...(options ? { options } : {}) });
      const result = responses[path];
      if (result instanceof Error) throw result;
      return result ?? {};
    },
    location: { origin: 'http://nr.local:1880' },
    document: { querySelector: () => null, createElement: (tag: string) => makeEl('', tag) },
    URL,
    setTimeout,
    clearTimeout,
    out: {} as Record<string, (...args: unknown[]) => unknown>,
    confirm,
  };
  runInNewContext(
    `(function () {
      function $(id) { return dom.get(id); }
      function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }
      function showToast(message, ok) { toasts.push({ message: message, ok: ok }); }
      function showFlash(el, msg) { if (el) { el.textContent = msg; el.hidden = !msg; } }
      function openConfirmDialog(opts) { confirm.opts = opts; }
      function applyStatus() {}
      function copyTextToClipboard() {}
      var editorRoot = ${JSON.stringify(editorRoot)};
      var mcpRpc = '/mcp/rpc';
      ${pageClientSettingsScript()}
      out.collectSettingsPayload = collectSettingsPayload;
      out.applySettings = applySettings;
      out.renderOAuthRouteWarning = renderOAuthRouteWarning;
      out.loadOAuthClients = loadOAuthClients;
      out.saveSettingsNow = saveSettingsNow;
      out.persistSettings = persistSettings;
      out.addSecretPattern = addSecretPattern;
      out.resetSecretPatterns = resetSecretPatterns;
    })();`,
    ctx
  );
  return { dom, calls, out: ctx.out, confirm, toasts };
}

describe('light theme only', () => {
  it('consent / sign-in page has no dark-mode variant', () => {
    const html = renderConsentPage({
      requestId: 'r',
      tokenKey: 'auth-tokens',
      adminRoot: '/',
      nonce: 'n',
      redirectHost: 'app.example',
      loopbackRedirect: false,
      clientName: 'App',
      scopes: ['read'],
      script: '',
    });
    expect(html).not.toContain('prefers-color-scheme');
    expect(html).toContain('color-scheme:light;');
  });
});

describe('helpers', () => {
  it('normalizeHttpAdminRoot collapses duplicate slashes', () => {
    expect(normalizeHttpAdminRoot(undefined)).toBe('/');
    expect(normalizeHttpAdminRoot('/')).toBe('/');
    expect(normalizeHttpAdminRoot('//')).toBe('/');
    expect(normalizeHttpAdminRoot('//evil.com')).toBe('/evil.com');
    expect(normalizeHttpAdminRoot('/a//b/')).toBe('/a/b');
  });
  it('acceptedMediaTypes drops q=0 ranges', () => {
    expect([...acceptedMediaTypes('text/html;q=0, text/event-stream;q=0.9')]).toEqual([
      'text/event-stream',
    ]);
    expect([...acceptedMediaTypes('text/html; q=0.001')]).toEqual(['text/html']);
    expect([...acceptedMediaTypes('')]).toEqual([]);
  });
});

describe('dashboard settings client', () => {
  it('shows a server TTL validation error without resetting the input or reporting success', async () => {
    const { dom, calls, out, toasts } = loadSettingsClient({
      '/settings': new Error('defaultLinkTtlSeconds must be an integer with a minimum of 1'),
    });
    dom.get('set-ttl').value = '0';
    await out.persistSettings!({ defaultLinkTtlSeconds: 0 });
    expect(dom.get('settings-flash').textContent).toContain('minimum of 1');
    expect(dom.get('set-ttl').value).toBe('0');
    expect(toasts).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it.each(['set-ttl', 'set-proposal-ttl', 'oauth-access-ttl', 'oauth-refresh-ttl'])(
    'shows the minimum for %s = 0 and never says settings saved',
    async id => {
      const { dom, calls, out } = loadSettingsClient({});
      out.applySettings!({
        canEdit: true,
        settings: {
          maxActiveLinks: 10,
          rateLimitWindowMs: 60000,
          rateLimitMaxPerIp: 600,
          rateLimitMaxPerToken: 300,
        },
        sources: {},
      });
      dom.get(id).value = '0';
      out.saveSettingsNow!();
      await new Promise(r => setTimeout(r, 0));
      expect(calls.filter(c => c.options?.method === 'PUT')).toHaveLength(0);
      expect(dom.get('settings-flash').textContent).toContain('minimum of 1');
      expect(dom.get('settings-flash').textContent).not.toContain('Settings saved');
      expect(dom.get(id).value).toBe('0');
      expect(dom.get(id).attrs['aria-invalid']).toBe('true');
    }
  );
  it('loads expiry days without silently clamping invalid input and locks configured values', () => {
    const { dom, out } = loadSettingsClient({});
    out.applySettings!({ canEdit: true, settings: {}, sources: {} });
    expect(dom.get('set-proposal-ttl').value).toBe('7');
    dom.get('set-proposal-ttl').value = '30';
    expect(out.collectSettingsPayload!()).toMatchObject({ proposalTtlDays: 30 });
    dom.get('set-proposal-ttl').value = '999';
    expect(out.collectSettingsPayload!()).toMatchObject({ proposalTtlDays: 999 });
    dom.get('set-proposal-ttl').value = '-1';
    expect(out.collectSettingsPayload!()).toMatchObject({ proposalTtlDays: -1 });
    out.applySettings!({
      canEdit: true,
      settings: { proposalTtlDays: 14 },
      sources: { proposalTtlDays: 'settings.js' },
    });
    expect(dom.get('set-proposal-ttl').value).toBe('14');
    expect(dom.get('set-proposal-ttl').disabled).toBe(true);
    expect(dom.get('lock-proposal-ttl').hidden).toBe(false);
    expect(out.collectSettingsPayload!()).not.toHaveProperty('proposalTtlDays');
    out.applySettings!({ canEdit: false, settings: {}, sources: {} });
    expect(dom.get('set-proposal-ttl').disabled).toBe(true);
  });
  it('escapes untrusted collision paths/names and links http-in nodes to the editor', () => {
    const { dom, out } = loadSettingsClient({}, '/admin');
    out.renderOAuthRouteWarning!({
      details: [
        {
          kind: 'metadata',
          path: '/.well-known/oauth-<b>x</b>',
          source: 'http-in',
          nodeId: 'n"1',
          nodeName: '<img src=x onerror=alert(1)>',
        },
        {
          kind: 'authorization',
          path: '/mcp/oauth/<i>t</i>',
          source: 'middleware',
          layer: '<svg>',
        },
        { kind: 'authorization', path: '/x', source: 'http-in', flowId: 'tab1' },
      ],
    });
    const html = dom.get('oauth-route-warning').innerHTML;
    expect(dom.get('oauth-route-warning').hidden).toBe(false);
    expect(html).not.toMatch(/<img|<b>|<i>|<svg>/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('href="/admin/#node/n%221"');
    expect(html).toContain('href="/admin/#flow/tab1"');
  });

  it('escapes collision hrefs (quotes, angle brackets, javascript: ids)', () => {
    const { dom, out } = loadSettingsClient({}, '/a"b');
    out.renderOAuthRouteWarning!({
      details: [
        { kind: 'metadata', path: '/p', source: 'http-in', nodeId: 'javascript:alert(1)' },
        { kind: 'metadata', path: '/p', source: 'http-in', nodeId: '"><svg onload=1>' },
        { kind: 'metadata', path: '/p', source: 'http-in', flowId: "t' onmouseover='x" },
      ],
    });
    const html = dom.get('oauth-route-warning').innerHTML;
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
    expect(hrefs).toEqual([
      '/a&quot;b/#node/javascript%3Aalert(1)',
      '/a&quot;b/#node/%22%3E%3Csvg%20onload%3D1%3E',
      "/a&quot;b/#flow/t'%20onmouseover%3D'x",
    ]);
    expect(html).not.toMatch(/<svg|href="javascript:/);
    // Every href stays relative to the editor root (no scheme injection).
    for (const h of hrefs) expect(h!.startsWith('/')).toBe(true);
  });

  it('openConfirmDialog renders title/message (client_name) via textContent only', () => {
    const script = pageClientScript();
    const fn = /function openConfirmDialog\(opts\) \{[\s\S]*?\n {2}\}/.exec(script)![0];
    expect(fn).toMatch(/title\.textContent = opts\.title/);
    expect(fn).toMatch(/msg\.textContent = opts\.message/);
    expect(fn).not.toMatch(/innerHTML/);
    // The revoke confirm passes the untrusted name as a plain message string.
    expect(pageClientSettingsScript()).toMatch(
      /message: 'Revoke OAuth client "' \+ \(c\.client_name \|\| c\.client_id\)/
    );
  });

  it('locks settings.js fields individually', () => {
    const { dom, out } = loadSettingsClient({});
    out.applySettings!({
      canEdit: true,
      adminAuthEnabled: true,
      settings: {},
      sources: { corsAllowedOrigins: 'settings.js', rateLimitMaxPerIp: 'settings.js' },
    });
    expect(dom.get('set-cors').disabled).toBe(true);
    expect(dom.get('set-rate-ip').disabled).toBe(true);
    expect(dom.get('lock-cors').hidden).toBe(false);
    expect(dom.get('lock-rate-ip').hidden).toBe(false);
    for (const id of ['public-url', 'rate-window', 'rate-token', 'max-links', 'ttl', 'deploy']) {
      expect(dom.get('set-' + id).disabled, id).toBe(false);
      expect(dom.get('lock-' + id).hidden, id).toBe(true);
    }
    expect(dom.get('oauth-access-ttl').disabled).toBe(false);
  });

  it('hides the conflict box when there are no conflicts', () => {
    const { dom, out } = loadSettingsClient({});
    out.renderOAuthRouteWarning!({ details: [] });
    expect(dom.get('oauth-route-warning').hidden).toBe(true);
  });

  it('escapes OAuth client names/ids and disables revoke without * permission', async () => {
    const { dom, out } = loadSettingsClient({
      '/oauth/clients': {
        clients: [{ client_id: '"><script>alert(1)</script>', client_name: '<img src=x>' }],
      },
    });
    out.applySettings!({ canEdit: false, adminAuthEnabled: true, settings: {}, sources: {} });
    await out.loadOAuthClients!();
    const html = dom.get('oauth-clients').innerHTML;
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain(' disabled>Revoke');
  });

  it('applies settings, locks settings.js fields, and PUTs a payload without locked keys', async () => {
    const { dom, out, calls } = loadSettingsClient({
      '/settings': { canEdit: true, adminAuthEnabled: true, settings: {}, sources: {} },
    });
    out.applySettings!({
      canEdit: true,
      adminAuthEnabled: true,
      trustProxy: 'loopback',
      settings: {
        enabled: true,
        defaultLinkTtlSeconds: 7200,
        maxActiveLinks: 9,
        publicBaseUrl: 'https://locked.example',
        corsAllowedOrigins: ['https://a.example'],
        rateLimitWindowMs: 60000,
        rateLimitMaxPerIp: 600,
        rateLimitMaxPerToken: 300,
        oauth: {
          enabled: true,
          accessTokenTtlSec: 5400,
          refreshIdleTtlSec: 2592000,
          dcrMaxClients: 5,
        },
      },
      sources: { publicBaseUrl: 'settings.js' },
    });
    expect(dom.get('set-public-url').disabled).toBe(true);
    expect(dom.get('lock-public-url').hidden).toBe(false);
    expect(dom.get('set-ttl').value).toBe('2');
    expect(dom.get('oauth-access-ttl').value).toBe('90');
    expect(dom.get('oauth-access-ttl-unit').value).toBe('minutes');
    expect(dom.get('oauth-refresh-ttl-unit').value).toBe('days');
    expect(dom.get('set-trust-proxy').textContent).toContain('loopback');
    expect(dom.get('oauth-server-url').textContent).toBe('https://locked.example/mcp');
    dom.get('set-rate-ip').value = '20';
    out.saveSettingsNow!();
    await new Promise(r => setTimeout(r, 0));
    const put = calls.find(c => c.options?.method === 'PUT');
    const body = JSON.parse(put!.options!.body!);
    expect(body.rateLimitMaxPerIp).toBe(20);
    expect(body).not.toHaveProperty('publicBaseUrl');
    expect(body.oauth).not.toHaveProperty('refreshMaxLifetimeSec');
  });

  it('read-only users cannot save', () => {
    const { out, calls } = loadSettingsClient({});
    out.applySettings!({ canEdit: false, adminAuthEnabled: true, settings: {}, sources: {} });
    out.saveSettingsNow!();
    expect(calls.some(c => c.options?.method === 'PUT')).toBe(false);
  });

  it('asks before enabling OAuth without a Public URL', () => {
    const { dom, out, calls, confirm } = loadSettingsClient({});
    out.applySettings!({
      canEdit: true,
      adminAuthEnabled: true,
      settings: {
        publicBaseUrl: '',
        oauth: { enabled: false },
        maxActiveLinks: 10,
        rateLimitWindowMs: 60000,
        rateLimitMaxPerIp: 600,
        rateLimitMaxPerToken: 300,
      },
      sources: {},
    });
    dom.get('oauth-enabled').checked = true;
    out.saveSettingsNow!();
    expect(confirm.opts).toBeDefined();
    expect(dom.get('oauth-enabled').checked).toBe(false);
    expect(calls.some(c => c.options?.method === 'PUT')).toBe(false);
  });

  describe('secret name patterns', () => {
    const base = {
      canEdit: true,
      adminAuthEnabled: true,
      settings: {
        secretNamePatterns: ['PASSWORD', '<img src=x onerror=alert(1)>'],
        maxActiveLinks: 10,
        rateLimitWindowMs: 60000,
        rateLimitMaxPerIp: 600,
        rateLimitMaxPerToken: 300,
      },
      sources: { secretNamePatterns: 'disk' },
    };

    function chipTexts(list: FakeEl): string[] {
      return list.children.map(li => li.children[0]?.textContent ?? '');
    }

    it('renders chips with textContent only (never HTML)', () => {
      const { dom, out } = loadSettingsClient({});
      out.applySettings!(base);
      const list = dom.get('secret-patterns');
      expect(chipTexts(list)).toEqual(['PASSWORD', '<img src=x onerror=alert(1)>']);
      expect(list.innerHTML).toBe('');
      for (const li of list.children) expect(li.innerHTML).toBe('');
      expect(dom.get('secret-patterns-source').textContent).toBe('(customized)');
      expect(dom.get('set-secret-reset').disabled).toBe(false);
    });

    it('remove, add (validated, uppercased), and reset to defaults', async () => {
      const { dom, out, calls, confirm } = loadSettingsClient({ '/settings': base });
      out.applySettings!(base);
      const firstChip = dom.get('secret-patterns').children[0]!;
      const remove = firstChip.children[1]!;
      expect(remove.attrs['aria-label']).toBe('Remove PASSWORD');
      remove.listeners.click![0]!();
      await new Promise(r => setTimeout(r, 0));
      const puts = () => calls.filter(c => c.options?.method === 'PUT');
      expect(JSON.parse(puts()[0]!.options!.body!)).toEqual({
        secretNamePatterns: ['<img src=x onerror=alert(1)>'],
      });

      dom.get('set-secret-new').value = 'bad value!';
      out.addSecretPattern!();
      expect(puts()).toHaveLength(1);
      expect(dom.get('settings-flash').textContent).toMatch(/2-40 letters/);

      dom.get('set-secret-new').value = ' pin ';
      out.addSecretPattern!();
      await new Promise(r => setTimeout(r, 0));
      expect(JSON.parse(puts()[1]!.options!.body!).secretNamePatterns).toEqual([
        'PASSWORD',
        '<img src=x onerror=alert(1)>',
        'PIN',
      ]);
      expect(dom.get('set-secret-new').value).toBe('');

      out.resetSecretPatterns!();
      await confirm.opts!.onConfirm!();
      await new Promise(r => setTimeout(r, 0));
      expect(JSON.parse(puts()[2]!.options!.body!)).toEqual({ secretNamePatterns: null });
    });

    it('locked by settings.js or read-only: no remove buttons, inputs disabled', () => {
      for (const data of [
        { ...base, sources: { secretNamePatterns: 'settings.js' } },
        { ...base, canEdit: false },
      ]) {
        const { dom, out, calls } = loadSettingsClient({});
        out.applySettings!(data);
        const list = dom.get('secret-patterns');
        for (const li of list.children) expect(li.children).toHaveLength(1);
        expect(dom.get('set-secret-new').disabled).toBe(true);
        expect(dom.get('set-secret-add').disabled).toBe(true);
        expect(dom.get('set-secret-reset').disabled).toBe(true);
        dom.get('set-secret-new').value = 'PIN';
        out.addSecretPattern!();
        expect(calls.some(c => c.options?.method === 'PUT')).toBe(false);
      }
      const locked = loadSettingsClient({});
      locked.out.applySettings!({ ...base, sources: { secretNamePatterns: 'settings.js' } });
      expect(locked.dom.get('lock-secret-patterns').hidden).toBe(false);
      expect(locked.dom.get('secret-patterns-source').textContent).toBe('(set in settings.js)');
    });

    it('collectSettingsPayload never sends secretNamePatterns', async () => {
      const { dom, out, calls } = loadSettingsClient({ '/settings': base });
      out.applySettings!(base);
      dom.get('set-rate-ip').value = '20';
      out.saveSettingsNow!();
      await new Promise(r => setTimeout(r, 0));
      const put = calls.find(c => c.options?.method === 'PUT');
      expect(JSON.parse(put!.options!.body!)).not.toHaveProperty('secretNamePatterns');
    });
  });
});
