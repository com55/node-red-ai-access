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

import { registerRoutes } from '../../src/plugin/index.js';
import { pageClientSettingsScript } from '../../src/plugin/page-client-settings.js';
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
    expect(html).toContain('prefers-color-scheme: dark');
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
}

function fakeDom() {
  const els = new Map<string, FakeEl>();
  const get = (id: string): FakeEl => {
    let el = els.get(id);
    if (!el) {
      el = {
        id,
        value: '',
        checked: false,
        disabled: false,
        hidden: false,
        textContent: '',
        innerHTML: '',
        className: '',
        listeners: {},
        addEventListener(ev, fn) {
          (this.listeners[ev] ??= []).push(fn);
        },
        querySelectorAll() {
          return [];
        },
      };
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
  const ctx = {
    dom,
    api: async (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, ...(options ? { options } : {}) });
      return responses[path] ?? {};
    },
    location: { origin: 'http://nr.local:1880' },
    document: { querySelector: () => null },
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
      function showToast() {}
      function showFlash(el, msg) { if (el) { el.textContent = msg; el.hidden = !msg; } }
      function openConfirmDialog(opts) { confirm.opts = opts; }
      function applyStatus() {}
      function copyTextToClipboard() {}
      var editorRoot = ${JSON.stringify(editorRoot)};
      var mcpRpc = '/mcp/rpc';
      ${pageClientSettingsScript()}
      out.applySettings = applySettings;
      out.renderOAuthRouteWarning = renderOAuthRouteWarning;
      out.loadOAuthClients = loadOAuthClients;
      out.saveSettingsNow = saveSettingsNow;
    })();`,
    ctx
  );
  return { dom, calls, out: ctx.out, confirm };
}

describe('dashboard settings client', () => {
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
      settings: { publicBaseUrl: '', oauth: { enabled: false } },
      sources: {},
    });
    dom.get('oauth-enabled').checked = true;
    out.saveSettingsNow!();
    expect(confirm.opts).toBeDefined();
    expect(dom.get('oauth-enabled').checked).toBe(false);
    expect(calls.some(c => c.options?.method === 'PUT')).toBe(false);
  });
});
