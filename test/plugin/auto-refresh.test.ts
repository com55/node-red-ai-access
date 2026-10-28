/* eslint-disable @typescript-eslint/no-empty-function -- DOM stubs */
/**
 * Auto-refresh behaviour: OAuth consent page auto-retries when the editor token
 * appears (storage / visibilitychange / focus); dashboard refreshes data when
 * the tab is shown again, throttled and never while a dialog or field is active.
 */
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { editorRevealListenerScript } from '../../src/plugin/editor-sidebar.js';
import { consentScript } from '../../src/plugin/oauth-consent-script.js';
import {
  pageClientAutoRefreshScript,
  pageClientEditorJumpScript,
} from '../../src/plugin/page-client.js';

type Listener = (ev: Record<string, unknown>) => void;

function emitter() {
  const listeners: Record<string, Listener[]> = {};
  return {
    listeners,
    addEventListener(ev: string, fn: Listener) {
      (listeners[ev] ??= []).push(fn);
    },
    emit(ev: string, data: Record<string, unknown> = {}) {
      for (const fn of listeners[ev] ?? []) fn(data);
    },
  };
}

const flush = () => new Promise(r => setTimeout(r, 10));

function consentHarness(loginType: string) {
  const els = new Map<string, Record<string, unknown>>();
  const el = (id: string) => {
    let e = els.get(id);
    if (!e) {
      e = {
        id,
        hidden: true,
        textContent: '',
        className: '',
        value: '',
        ...emitter(),
        append() {},
        focus() {},
        contains: () => false,
        classList: { toggle() {} },
      };
      els.set(id, e);
    }
    return e;
  };
  const main = {
    getAttribute: (k: string) =>
      ({ 'data-request': 'req1', 'data-token-key': 'auth-tokens', 'data-admin-root': '/' })[k] ??
      null,
  };
  const store = new Map<string, string>();
  const calls: string[] = [];
  const win = emitter();
  const doc = {
    ...emitter(),
    visibilityState: 'visible',
    activeElement: null,
    querySelector: (q: string) => (q === 'main' ? main : null),
    querySelectorAll: () => [],
    getElementById: el,
    createElement: () => ({}),
  };
  const fetch = (url: string) => {
    calls.push(String(url));
    if (String(url).includes('auth/login'))
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ type: loginType }),
      });
    const signed = store.has('auth-tokens');
    return Promise.resolve({
      status: signed ? 200 : 401,
      ok: signed,
      json: () =>
        Promise.resolve(
          signed
            ? { requested: ['read'], grantable: ['read'], user: 'alice', csrf: 'c' }
            : { error: 'auth' }
        ),
    });
  };
  const ctx = {
    document: doc,
    window: Object.assign(win, {
      location: { href: 'http://nr/mcp/oauth/authorize', assign() {} },
    }),
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
    fetch,
    URL,
    URLSearchParams,
    JSON,
    Date,
  };
  runInNewContext(consentScript, ctx);
  const consentCalls = () => calls.filter(c => c.startsWith('consent/')).length;
  return { el, store, win, doc, consentCalls };
}

describe('OAuth consent page auto-retry', () => {
  it('strategy login: shows Retry, then auto-loads on storage event', async () => {
    const h = consentHarness('strategy');
    await flush();
    expect(h.el('retry').hidden).toBe(false);
    expect(h.consentCalls()).toBe(1);
    // focus without a token does nothing
    h.win.emit('focus');
    await flush();
    expect(h.consentCalls()).toBe(1);
    h.store.set('auth-tokens', JSON.stringify({ access_token: 't' }));
    h.win.emit('storage', { key: 'auth-tokens', newValue: '{"access_token":"t"}' });
    await flush();
    expect(h.consentCalls()).toBe(2);
    expect(h.el('allow').hidden).toBe(false);
    expect(h.el('username-label').textContent).toBe('alice');
    // once signed in, further focus/visibility events do not reload
    h.win.emit('focus');
    h.doc.emit('visibilitychange');
    await flush();
    expect(h.consentCalls()).toBe(2);
  });

  it('auto-loads on visibilitychange when the token exists', async () => {
    const h = consentHarness('strategy');
    await flush();
    h.store.set('auth-tokens', JSON.stringify({ access_token: 't' }));
    h.doc.emit('visibilitychange');
    await flush();
    expect(h.consentCalls()).toBe(2);
    expect(h.el('allow').hidden).toBe(false);
  });

  it('credentials login: ignores unrelated storage keys', async () => {
    const h = consentHarness('credentials');
    await flush();
    expect(h.el('login').hidden).toBe(false);
    h.win.emit('storage', { key: 'other', newValue: 'x' });
    await flush();
    expect(h.consentCalls()).toBe(1);
  });
});

function dashboardHarness() {
  const calls: string[] = [];
  const win = emitter();
  let openDialog: unknown = null;
  const doc = {
    ...emitter(),
    visibilityState: 'visible',
    activeElement: null as unknown,
    body: {},
    documentElement: { setAttribute() {} },
    querySelector: (q: string) => (q === 'dialog[open]' ? openDialog : null),
  };
  let now = 100_000;
  const ctx = {
    document: doc,
    window: win,
    Date: { now: () => now },
    String,
    api: (p: string) => {
      calls.push(p);
      return Promise.resolve({});
    },
    applyStatus: () => calls.push('applyStatus'),
    loadLinks: () => calls.push('links'),
    loadProposals: () => calls.push('proposals'),
    loadLogs: () => calls.push('logs'),
    loadOAuthStatus: () => calls.push('oauthStatus'),
    loadOAuthClients: () => calls.push('oauthClients'),
    aiOn: true,
    canManage: true,
  };
  runInNewContext(`(function(){ ${pageClientAutoRefreshScript()} })();`, ctx);
  return {
    calls,
    win,
    doc,
    advance: (ms: number) => {
      now += ms;
    },
    setDialog: (d: unknown) => {
      openDialog = d;
    },
  };
}

describe('dashboard auto-refresh', () => {
  it('refreshes status + lists on visibility, throttled to 5s', async () => {
    const h = dashboardHarness();
    h.doc.emit('visibilitychange');
    await flush();
    expect(h.calls).toEqual([]); // < 5s since page load
    h.advance(6000);
    h.doc.emit('visibilitychange');
    await flush();
    expect(h.calls).toEqual(['/status', 'applyStatus', 'links', 'proposals', 'logs']);
    h.win.emit('focus');
    await flush();
    expect(h.calls).toHaveLength(5); // throttled
  });

  it('skips while a dialog (one-time token modal) is open or a field is focused', async () => {
    const h = dashboardHarness();
    h.advance(6000);
    h.setDialog({ id: 'token-modal' });
    h.win.emit('focus');
    await flush();
    expect(h.calls).toEqual([]);
    h.setDialog(null);
    h.doc.activeElement = { tagName: 'INPUT' };
    h.win.emit('focus');
    await flush();
    expect(h.calls).toEqual([]);
    h.doc.activeElement = h.doc.body;
    h.win.emit('focus');
    await flush();
    expect(h.calls[0]).toBe('/status');
  });

  it('ignores the hidden state', async () => {
    const h = dashboardHarness();
    h.advance(6000);
    h.doc.visibilityState = 'hidden';
    h.doc.emit('visibilitychange');
    await flush();
    expect(h.calls).toEqual([]);
  });
});

class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(public name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: unknown) {
    for (const c of FakeChannel.all) {
      if (c !== this && !c.closed && c.name === this.name)
        c.onmessage?.({ data: structuredClone(data) });
    }
  }
  close() {
    this.closed = true;
  }
}

function jumpHarness() {
  const doc = emitter();
  const opened: { url: string; name: string }[] = [];
  const toasts: string[] = [];
  const ctx = {
    document: doc,
    window: { open: (url: string, name: string) => (opened.push({ url, name }), { focus() {} }) },
    BroadcastChannel: FakeChannel,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    String,
    encodeURIComponent,
    editorRoot: '/',
    esc: (x: string) =>
      String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    showToast: (m: string) => toasts.push(m),
    out: {} as Record<string, (...a: unknown[]) => string>,
  };
  runInNewContext(
    `(function(){ ${pageClientEditorJumpScript()}; out.link = editorJumpLink; })();`,
    ctx
  );
  const click = (kind: string, id: string) => {
    const a = {
      getAttribute: (k: string) =>
        ({ 'data-reveal-kind': kind, 'data-reveal-id': id, href: `/#${kind}/${id}` })[k],
    };
    let prevented = false;
    doc.emit('click', {
      target: { closest: () => a },
      button: 0,
      preventDefault: () => (prevented = true),
      stopPropagation() {},
    });
    return prevented;
  };
  return { ctx, opened, toasts, click };
}

function editorHarness(known: Record<string, 'node' | 'flow'>) {
  const revealed: string[] = [];
  const RED = {
    nodes: {
      node: (id: string) => (known[id] === 'node' ? {} : null),
      group: () => null,
      workspace: (id: string) => (known[id] === 'flow' ? {} : null),
      subflow: () => null,
    },
    view: { reveal: (id: string) => revealed.push(`node:${id}`) },
    workspaces: { show: (id: string) => revealed.push(`flow:${id}`) },
  };
  const win: Record<string, unknown> = { name: '', focus() {} };
  runInNewContext(editorRevealListenerScript(), {
    RED,
    BroadcastChannel: FakeChannel,
    window: win,
  });
  return { revealed, win };
}

describe('dashboard → editor jump links', () => {
  it('renders #flow/ and #node/ links with escaping and a named target', () => {
    const h = jumpHarness();
    const html = h.ctx.out.link!('node', 'a"b', '<x>');
    expect(html).toContain('href="/#node/a%22b"');
    expect(html).toContain('target="node-red-editor"');
    expect(html).toContain('&lt;x>');
  });

  it('reuses an open editor tab via BroadcastChannel (no window.open)', async () => {
    FakeChannel.all = [];
    const ed = editorHarness({ n1: 'node', f1: 'flow' });
    expect(ed.win.name).toBe('node-red-editor');
    const h = jumpHarness();
    expect(h.click('node', 'n1')).toBe(true);
    h.click('flow', 'f1');
    await new Promise(r => setTimeout(r, 350));
    expect(ed.revealed).toEqual(['node:n1', 'flow:f1']);
    expect(h.opened).toEqual([]);
    expect(h.toasts[0]).toMatch(/open Node-RED editor/);
  });

  it('falls back to window.open(url, "node-red-editor") without an editor', async () => {
    FakeChannel.all = [];
    const h = jumpHarness();
    h.click('node', 'n1');
    await new Promise(r => setTimeout(r, 350));
    expect(h.opened).toEqual([{ url: '/#node/n1', name: 'node-red-editor' }]);
  });

  it('editor that does not know the id: toast, no new tab', async () => {
    FakeChannel.all = [];
    editorHarness({});
    const h = jumpHarness();
    h.click('node', 'ghost');
    await new Promise(r => setTimeout(r, 350));
    expect(h.opened).toEqual([]);
    expect(h.toasts[0]).toMatch(/Not found/);
  });
});
