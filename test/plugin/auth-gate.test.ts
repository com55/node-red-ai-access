/* eslint-disable @typescript-eslint/no-empty-function -- DOM stubs */
/**
 * Dashboard signed-out card: credentials → inline sign-in via /auth/token
 * (token stored under the editor key); strategy → open the editor window and
 * continue automatically on storage / focus with a new token, Retry fallback.
 */
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { pageClientScript } from '../../src/plugin/page-client.js';
import { renderMcpPage } from '../../src/plugin/page.js';

type Listener = (ev: Record<string, unknown>) => void;

function emitter() {
  const listeners: Record<string, Listener[]> = {};
  return {
    addEventListener(ev: string, fn: Listener) {
      (listeners[ev] ??= []).push(fn);
    },
    emit(ev: string, data: Record<string, unknown> = {}) {
      for (const fn of listeners[ev] ?? []) fn(data);
    },
  };
}

function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`no ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const flush = () => new Promise(r => setTimeout(r, 10));

function gateHarness(loginType: string, tokenOk = true, editorRoot = '/') {
  const src = pageClientScript();
  const fns = [
    'readEditorToken',
    'editorLoginUrl',
    'authGateAdminHref',
    'authGateStatus',
    'authGateContinue',
    'authGateTyping',
    'authGateAuto',
    'wireAuthGate',
    'wireAuthGateEditor',
    'showAuthGate',
    'nrLoginType',
    'nrPasswordSignIn',
  ]
    .map(n => extractFn(src, n))
    .join('\n');
  const els = new Map<string, Record<string, unknown> & ReturnType<typeof emitter>>();
  const el = (id: string) => {
    let e = els.get(id);
    if (!e) {
      e = {
        id,
        hidden: id.startsWith('auth-gate'),
        value: '',
        textContent: '',
        className: '',
        disabled: false,
        focus() {},
        setAttribute(name: string, value: string) {
          this[name] = value;
        },
        ...emitter(),
      };
      els.set(id, e);
    }
    return e;
  };
  const store = new Map<string, string>();
  const fetches: { url: string; method: string; body?: string }[] = [];
  const opened: { url: string; name: string }[] = [];
  let reloads = 0;
  let now = 2000;
  const win = Object.assign(emitter(), {
    open: (url: string, name: string) => opened.push({ url, name }),
  });
  const doc = Object.assign(emitter(), {
    visibilityState: 'visible',
    body: { classList: { add() {} } },
  });
  const fetch = (url: string, init?: { method?: string; body?: string }) => {
    fetches.push({ url, method: init?.method ?? 'GET', body: init?.body });
    if (url.endsWith('/auth/login'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ type: loginType }) });
    return Promise.resolve({
      ok: tokenOk,
      status: tokenOk ? 200 : 403,
      json: () => Promise.resolve(tokenOk ? { access_token: 'tok1', expires_in: 1 } : {}),
    });
  };
  const ctx = {
    document: doc,
    window: win,
    location: { href: 'http://nr/ai-access', reload: () => reloads++ },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
    fetch,
    URL,
    URLSearchParams,
    JSON,
    Date: { now: () => now },
    String,
    out: {} as Record<string, () => void>,
  };
  runInNewContext(
    `var editorRoot = ${JSON.stringify(editorRoot)}, authTokenKey = 'auth-tokens';
     var $ = function (id) { return getEl(id); };
     var authGateShown = false, authGateToken = null, authGateLastAuto = 0, authGateEditorOpened = false;
     ${fns}
     out.show = showAuthGate;`,
    Object.assign(ctx, { getEl: el })
  );
  return {
    ctx,
    el,
    store,
    fetches,
    opened,
    win,
    doc,
    reloads: () => reloads,
    advance: () => {
      now += 2000;
    },
  };
}

describe('dashboard signed-out card', () => {
  it('renders the optional editor link below the inline form, hidden until credentials are detected', () => {
    const html = renderMcpPage({
      apiBase: '/mcp/api/v1',
      editorRoot: '/',
      authTokenKey: 'auth-tokens',
    });
    expect(html).toMatch(
      /<\/form>\s*<a id="auth-gate-editor-link"[^>]*hidden>or sign in via the editor<\/a>/
    );
  });

  it.each(['credentials', 'strategy'])(
    '%s: editor handoff respects a custom admin root',
    async type => {
      const h = gateHarness(type, true, '/red/');
      h.ctx.out.show!();
      await flush();
      const control = type === 'credentials' ? 'auth-gate-editor-link' : 'auth-gate-editor';
      h.el(control).emit('click', { preventDefault() {} });
      expect(h.opened).toEqual([{ url: '/red/', name: 'node-red-editor' }]);
      expect(h.el('auth-gate-editor-link').href).toBe('/red/');
    }
  );

  it('credentials: inline form posts to /auth/token, stores editor token, reloads', async () => {
    const h = gateHarness('credentials');
    h.ctx.out.show!();
    h.ctx.out.show!(); // a second 401 does not rewire / duplicate
    await flush();
    expect(h.el('auth-gate').hidden).toBe(false);
    expect(h.el('auth-gate-login').hidden).toBe(false);
    expect(h.el('auth-gate-editor').hidden).toBe(true);
    h.el('auth-gate-username').value = 'admin';
    h.el('auth-gate-password').value = 'pw';
    h.el('auth-gate-login').emit('submit', { preventDefault() {} });
    await flush();
    const post = h.fetches.find(f => f.method === 'POST')!;
    expect(post.url).toBe('http://nr/auth/token');
    const body = new URLSearchParams(post.body);
    expect(body.get('client_id')).toBe('node-red-editor');
    expect(body.get('grant_type')).toBe('password');
    expect(body.get('username')).toBe('admin');
    expect(JSON.parse(h.store.get('auth-tokens')!).access_token).toBe('tok1');
    expect(h.el('auth-gate-password').value).toBe('');
    expect(h.reloads()).toBe(1);
    expect(h.fetches.filter(f => f.method === 'POST')).toHaveLength(1);
  });

  it('credentials: wrong password shows an error and does not reload', async () => {
    const h = gateHarness('credentials', false);
    h.ctx.out.show!();
    await flush();
    h.el('auth-gate-username').value = 'admin';
    h.el('auth-gate-password').value = 'bad';
    h.el('auth-gate-login').emit('submit', { preventDefault() {} });
    await flush();
    expect(h.el('auth-gate-status').textContent).toMatch(/Sign in failed/);
    expect(h.el('auth-gate-status').className).toContain('error');
    expect(h.store.has('auth-tokens')).toBe(false);
    expect(h.reloads()).toBe(0);
  });

  it('strategy: opens the named editor window and continues on the storage event', async () => {
    const h = gateHarness('strategy');
    h.ctx.out.show!();
    await flush();
    expect(h.el('auth-gate-login').hidden).toBe(true);
    expect(h.el('auth-gate-editor').hidden).toBe(false);
    expect(h.el('auth-gate-retry').hidden).toBe(false);
    h.el('auth-gate-editor').emit('click', { preventDefault() {} });
    expect(h.opened).toEqual([{ url: '/', name: 'node-red-editor' }]);
    h.win.emit('focus');
    h.el('auth-gate-retry').emit('click');
    expect(h.reloads()).toBe(0);
    expect(h.el('auth-gate-status').textContent).toMatch(/Not signed in yet/);
    h.win.emit('storage', { key: 'other', newValue: 'x' });
    expect(h.reloads()).toBe(0);
    h.store.set('auth-tokens', '{"access_token":"t2"}');
    h.win.emit('storage', { key: 'auth-tokens', newValue: '{"access_token":"t2"}' });
    expect(h.reloads()).toBe(1);
    expect(h.fetches.some(f => f.method === 'POST')).toBe(false);
  });

  it.each(['credentials', 'strategy', 'unknown'])(
    '%s: shows the secondary editor link only for credentials',
    async type => {
      const h = gateHarness(type);
      h.ctx.out.show!();
      await flush();
      expect(h.el('auth-gate-editor-link').hidden).toBe(type !== 'credentials');
      expect(h.el('auth-gate-editor-link').href).toBe('/');
    }
  );

  it('credentials: editor link opens the named window and continues on storage, even with a partial form', async () => {
    const h = gateHarness('credentials');
    h.ctx.out.show!();
    h.ctx.out.show!();
    await flush();
    h.el('auth-gate-username').value = 'admin';
    let prevented = false;
    h.el('auth-gate-editor-link').emit('click', {
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(h.opened).toEqual([{ url: '/', name: 'node-red-editor' }]);
    expect(h.el('auth-gate-login').hidden).toBe(false);
    expect(h.el('auth-gate-retry').hidden).toBe(false);
    h.el('auth-gate-retry').emit('click');
    expect(h.reloads()).toBe(0);
    expect(h.el('auth-gate-status').textContent).toMatch(/Not signed in yet/);
    h.store.set('auth-tokens', '{"access_token":"fresh"}');
    h.win.emit('storage', { key: 'auth-tokens', newValue: '{"access_token":"fresh"}' });
    expect(h.reloads()).toBe(1);
    expect(h.fetches.some(f => f.method === 'POST')).toBe(false);
  });

  it.each(['focus', 'visibilitychange'])(
    'credentials: editor handoff continues on %s with a new token despite a partial form',
    async event => {
      const h = gateHarness('credentials');
      h.ctx.out.show!();
      await flush();
      h.el('auth-gate-username').value = 'admin';
      h.store.set('auth-tokens', '{"access_token":"fresh"}');
      h.win.emit('focus');
      expect(h.reloads()).toBe(0); // Preserve typing until the editor is explicitly chosen.
      h.el('auth-gate-editor-link').emit('click', { preventDefault() {} });
      if (event === 'focus') h.win.emit(event);
      else h.doc.emit(event);
      expect(h.reloads()).toBe(1);
    }
  );

  it('credentials: Retry continues after editor sign-in when automatic events are unavailable', async () => {
    const h = gateHarness('credentials');
    h.ctx.out.show!();
    await flush();
    h.el('auth-gate-editor-link').emit('click', { preventDefault() {} });
    h.store.set('auth-tokens', '{"access_token":"fresh"}');
    h.el('auth-gate-retry').emit('click');
    expect(h.reloads()).toBe(1);
  });

  it.each(['credentials', 'strategy'])(
    '%s: stale rejected token does not loop on storage, focus or visibility',
    async type => {
      const h = gateHarness(type);
      h.store.set('auth-tokens', '{"access_token":"stale"}');
      h.ctx.out.show!();
      await flush();
      const control = type === 'credentials' ? 'auth-gate-editor-link' : 'auth-gate-editor';
      h.el(control).emit('click', { preventDefault() {} });
      for (let i = 0; i < 2; i++) {
        h.win.emit('storage', { key: 'auth-tokens', newValue: '{"access_token":"stale"}' });
        h.win.emit('focus');
        h.doc.emit('visibilitychange');
        h.advance(); // Stale tokens stay rejected even beyond the event throttle.
      }
      expect(h.reloads()).toBe(0);
      h.store.set('auth-tokens', '{"access_token":"fresh"}');
      h.win.emit('focus');
      expect(h.reloads()).toBe(1);
    }
  );
});
