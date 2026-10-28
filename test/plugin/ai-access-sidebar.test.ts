/**
 * Editor sidebar tab — thin ai-access.html loader + served sidebar JS.
 *
 * Node-RED 4.x wraps content in #red-ui-sidebar-content and lists the tab
 * (by name) in the View menu / sidebar dropdown next to Information, Help, etc.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import {
  EDITOR_SIDEBAR_ASSET_VERSION,
  renderEditorSidebarJs,
  renderEditorSidebarLoaderHtml,
} from '../../src/plugin/editor-sidebar.js';
import { packageVersion } from '../../src/plugin/package-version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const htmlPath = join(root, 'ai-access.html');

/** Minimal jQuery-like chain used by the sidebar script. */
function createFakeJQuery() {
  interface El {
    id?: string;
    className?: string;
    tag: string;
    textContent: string;
    htmlContent: string;
    attrs: Record<string, string>;
    children: El[];
    parent?: El;
    props: Record<string, unknown>;
    handlers: Record<string, ((...args: unknown[]) => void)[]>;
  }

  function makeEl(tag: string, attrs: Record<string, string> = {}): El {
    return {
      tag,
      textContent: '',
      htmlContent: '',
      attrs: { ...attrs },
      children: [],
      props: {},
      handlers: {},
      id: attrs.id,
      className: attrs.class,
    };
  }

  function wrap(els: El[]) {
    const api: Record<string, unknown> & { elements: El[]; length: number } = {
      length: els.length,
      0: els[0],
      elements: els,
      attr(name: string, value?: string) {
        if (value === undefined) {
          return els[0]?.attrs[name] ?? els[0]?.id;
        }
        for (const el of els) {
          el.attrs[name] = value;
          if (name === 'id') {
            el.id = value;
            registry.set(value, el);
          }
          if (name === 'class') el.className = value;
        }
        return api;
      },
      text(value?: string) {
        if (value === undefined) return els[0]?.textContent ?? '';
        for (const el of els) {
          el.textContent = value;
          el.children = [];
        }
        return api;
      },
      empty() {
        for (const el of els) el.children = [];
        return api;
      },
      html(value?: string) {
        if (value === undefined) return els[0]?.htmlContent ?? '';
        for (const el of els) el.htmlContent = value;
        return api;
      },
      appendTo(parent: { elements?: El[] }) {
        const target = parent?.elements?.[0];
        if (target) {
          for (const el of els) {
            target.children.push(el);
            el.parent = target;
          }
        }
        return api;
      },
      parent() {
        return wrap(els.flatMap(el => (el.parent ? [el.parent] : [])));
      },
      closest(selector: string) {
        const matches: El[] = [];
        for (const el of els) {
          let current: El | undefined = el;
          while (current && !current.className?.split(/\s+/).includes(selector.slice(1)))
            current = current.parent;
          if (current) matches.push(current);
        }
        return wrap(matches);
      },
      find(selector: string) {
        return wrap(selector.split(',').flatMap(part => $(part.trim()).elements));
      },
      append(child: { elements?: El[] } | string) {
        if (typeof child === 'string') return api;
        const kids = child.elements ?? [];
        for (const el of els) {
          for (const kid of kids) el.children.push(kid);
        }
        return api;
      },
      prop(name: string, value?: unknown) {
        if (value === undefined) return els[0]?.props[name];
        for (const el of els) el.props[name] = value;
        return api;
      },
      toggle(visible?: boolean) {
        for (const el of els) el.props.visible = visible;
        return api;
      },
      show() {
        for (const el of els) el.props.visible = true;
        return api;
      },
      hide() {
        for (const el of els) el.props.visible = false;
        return api;
      },
      toggleClass(name: string, on?: boolean) {
        for (const el of els) {
          const parts = new Set(
            String(el.className ?? '')
              .split(/\s+/)
              .filter(Boolean)
          );
          const enable = on === undefined ? !parts.has(name) : !!on;
          if (enable) parts.add(name);
          else parts.delete(name);
          el.className = [...parts].join(' ');
          el.attrs.class = el.className;
        }
        return api;
      },
      addClass(name: string) {
        return api.toggleClass(name, true);
      },
      removeClass(name: string) {
        for (const n of String(name).split(/\s+/)) {
          if (n) api.toggleClass(n, false);
        }
        return api;
      },
      hasClass(name: string) {
        return String(els[0]?.className ?? '')
          .split(/\s+/)
          .includes(name);
      },
      is(selector: string) {
        return selector === ':checked' && !!els[0]?.props.checked;
      },
      val(value?: unknown) {
        if (value === undefined) return els[0]?.props.value;
        for (const el of els) el.props.value = value;
        return api;
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        for (const el of els) {
          el.handlers[event] ??= [];
          el.handlers[event].push(handler);
        }
        return api;
      },
      off(event: string) {
        for (const el of els) el.handlers[event] = [];
        return api;
      },
      each(fn: (this: unknown, i: number) => void) {
        els.forEach((el, i) => {
          fn.call(wrap([el]), i);
        });
        return api;
      },
    };
    return api;
  }

  const registry = new Map<string, El>();

  function $(input?: unknown, attrs?: Record<string, string>) {
    if (typeof input === 'string') {
      if (input.startsWith('<')) {
        const tagMatch = /^<(\w+)/.exec(input);
        const tag = tagMatch?.[1] ?? 'div';
        const idMatch = /id=['"]([^'"]+)['"]/.exec(input);
        const classMatch = /class=['"]([^'"]+)['"]/.exec(input);
        const el = makeEl(tag, {
          ...(idMatch ? { id: idMatch[1]! } : {}),
          ...(classMatch ? { class: classMatch[1]! } : {}),
          ...(attrs ?? {}),
        });
        if (attrs) {
          Object.assign(el.attrs, attrs);
          if (attrs.id) el.id = attrs.id;
          if (attrs.class) el.className = attrs.class;
        }
        if (el.id) registry.set(el.id, el);
        return wrap([el]);
      }
      const byId = registry.get(input.replace(/^#/, ''));
      return wrap(byId ? [byId] : []);
    }
    return wrap([]);
  }

  return $;
}

describe('ai-access.html sidebar loader', () => {
  it('is a thin cache-busting loader (no inline Save / deploy markup)', () => {
    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toMatch(/ai-access-sidebar\.js\?v=/);
    expect(html).toMatch(new RegExp(EDITOR_SIDEBAR_ASSET_VERSION));
    expect(html).toMatch(/RED\.sidebar/);
    expect(html).not.toMatch(/ai-access-save/);
    expect(html).not.toMatch(/RED\.userSettings\.add/);
    expect(html).not.toMatch(/Only changed nodes \(recommended\)/);
  });

  it('derives asset version from package.json (single source of truth)', () => {
    expect(EDITOR_SIDEBAR_ASSET_VERSION).toBe(packageVersion());
    expect(EDITOR_SIDEBAR_ASSET_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const version = packageVersion();
    const loader = renderEditorSidebarLoaderHtml();
    const html = readFileSync(htmlPath, 'utf8');
    expect(loader).toContain(`EDITOR_SIDEBAR_ASSET_VERSION = '${version}'`);
    expect(html).toContain(`EDITOR_SIDEBAR_ASSET_VERSION = '${version}'`);
    // No hand-typed rN-N token — version comes from the package.
    expect(EDITOR_SIDEBAR_ASSET_VERSION).not.toMatch(/^r\d/);
  });
});

describe('ai-access-sidebar.js served tab', () => {
  it('registers RED.sidebar.addTab with content element and no userSettings', () => {
    const scriptBody = renderEditorSidebarJs();
    expect(scriptBody).toMatch(/RED\.sidebar\.addTab/);
    expect(scriptBody).not.toMatch(/RED\.userSettings\.add/);
    expect(scriptBody).toMatch(/#red-ui-sidebar-ai-access|red-ui-sidebar-ai-access/);

    const added: {
      id: string;
      label: string;
      name: string;
      iconClass: string;
      content: { attr: (n: string) => string; length: number };
      action?: string;
      onchange?: () => void;
      enableOnEdit?: boolean;
    }[] = [];
    const actions: string[] = [];

    const $ = createFakeJQuery();
    const context = {
      window: {} as Record<string, unknown>,
      document: {
        getElementById: () => null,
        createElement: () => ({
          id: '',
          textContent: '',
        }),
        head: {
          appendChild(_node: unknown) {
            return _node;
          },
        },
      },
      RED: {
        sidebar: {
          addTab(opts: (typeof added)[number]) {
            added.push(opts);
          },
          show() {
            return undefined;
          },
        },
        actions: {
          add(id: string) {
            actions.push(id);
          },
        },
        settings: { httpAdminRoot: '/' },
      },
      $,
      localStorage: { getItem: () => null },
      fetch: () => Promise.reject(new Error('no fetch in unit test')),
      console,
    };
    (context.window as { __com55AiAccessSidebarLoaded?: boolean }).__com55AiAccessSidebarLoaded =
      undefined;

    runInNewContext(scriptBody, context);

    expect(added).toHaveLength(1);
    expect(added[0]?.id).toBe('ai-access');
    expect(added[0]?.label).toBe('AI Access');
    expect(added[0]?.name).toBe('AI Access');
    expect(added[0]?.iconClass).toMatch(/fa fa-/);
    expect(added[0]?.enableOnEdit).toBe(true);
    expect(typeof added[0]?.onchange).toBe('function');
    expect(added[0]?.action).toBe('com55:show-ai-access-tab');
    expect(actions).toContain('com55:show-ai-access-tab');

    const content = added[0]!.content;
    expect(content.length).toBe(1);
    expect(content.attr('id')).toBe('red-ui-sidebar-ai-access');
  });

  it('auto-saves only (no Save), Refresh in header, dashboard button', () => {
    const js = renderEditorSidebarJs();
    expect(js).toMatch(/Changes apply immediately/);
    expect(js).not.toMatch(/ai-access-save/);
    expect(js).not.toMatch(/\.text\('Save'\)/);
    expect(js).toMatch(/ai-access-refresh/);
    expect(js).toMatch(/Open AI Access dashboard/);
    expect(js).toMatch(/\/ai-access/);
    expect(js).toMatch(/canEdit|readonly|\*/);
    expect(js).toMatch(new RegExp(`v=${EDITOR_SIDEBAR_ASSET_VERSION}`));
    expect(js).toMatch(/showSavedToast|Saved/);
    expect(js).toMatch(/2000/);
    expect(js).toMatch(/is-visible/);
    expect(js).toMatch(/opacity:\s*0/);
    // Saved toast sits in the header (not an absolute overlay over the intro).
    expect(js).toMatch(/red-ui-sidebar-header[\s\S]*ai-access-flash/);
    expect(js).toMatch(/#ai-access-flash:not\(\.is-visible\)/);
    expect(js).toMatch(/removeClass\('ok error'\)/);
    expect(js).not.toMatch(/#ai-access-flash \{[^}]*position:\s*absolute/);
  });

  it('keeps only the two toggles, conflict warning and dashboard button (settings moved to dashboard)', () => {
    const js = renderEditorSidebarJs();
    for (const moved of [
      'ai-access-public-url',
      'ai-access-cors',
      'ai-access-rate-ip',
      'ai-access-rate-window',
      'ai-access-rate-token',
      'ai-access-max-links',
      'ai-access-deploy',
      'ai-access-ttl',
      'ai-access-oauth-clients',
      'ai-access-oauth-access-ttl',
      'ai-access-oauth-dcr-cap',
      'ai-access-check-public-url',
      'ai-access-trust-proxy',
      'ai-access-pending-line',
    ]) {
      expect(js, moved).not.toContain(`id="${moved}"`);
    }
    expect(js).toContain('id="ai-access-enabled"');
    expect(js).toContain('id="ai-access-oauth-enabled"');
    expect(js).toContain('id="ai-access-oauth-route-warning"');
    expect(js).toContain('id="ai-access-open-mcp"');
  });

  function runSidebar(
    fetcher: (url: string, options?: { method?: string; body?: string }) => unknown
  ) {
    const $ = createFakeJQuery();
    let load!: () => void;
    const opened: string[] = [];
    runInNewContext(renderEditorSidebarJs(), {
      window: {
        setTimeout,
        open(url: string) {
          opened.push(url);
        },
      },
      URL,
      setTimeout,
      clearTimeout,
      $,
      fetch: fetcher,
      localStorage: { getItem: () => null },
      document: {
        getElementById: () => null,
        createElement: () => ({}),
        head: {
          appendChild() {
            return undefined;
          },
        },
      },
      RED: {
        settings: {},
        view: { reveal: vi.fn() },
        actions: {
          add() {
            return undefined;
          },
        },
        sidebar: {
          addTab(options: { onchange: () => void }) {
            load = options.onchange;
          },
          show() {
            return undefined;
          },
        },
      },
    });
    return { $, load: () => load(), opened };
  }

  it.each([true, false])(
    'renders toggle locks and read-only controls (canEdit=%s)',
    async canEdit => {
      vi.useFakeTimers();
      try {
        const settings = { enabled: true, allowWithoutAdminAuth: false, oauth: { enabled: true } };
        const data = {
          canEdit,
          adminAuthEnabled: true,
          mcpPageUrl: '/ai-access',
          settings,
          sources: { oauth: 'settings.js' },
        };
        const fetcher = vi.fn(async (url: string, _options?: unknown) => ({
          ok: true,
          text: async () => JSON.stringify(url.endsWith('/oauth/status') ? { details: [] } : data),
        }));
        const { $, load, opened } = runSidebar(fetcher);
        load();
        await vi.advanceTimersByTimeAsync(0);
        expect($('#ai-access-enabled').elements[0]!.props).toMatchObject({
          checked: true,
          disabled: !canEdit,
        });
        expect($('#ai-access-oauth-enabled').elements[0]!.props).toMatchObject({
          checked: true,
          disabled: true,
        });
        expect($('#ai-access-oauth-lock').elements[0]!.props.visible).toBe(true);
        expect($('#ai-access-readonly-note').elements[0]!.props.visible).toBe(!canEdit);
        // No conflicts → warning hidden.
        expect($('#ai-access-oauth-route-warning').elements[0]!.props.visible).toBe(false);
        expect(
          ($('#ai-access-dialog').elements[0] as unknown as { parent?: { id?: string } }).parent?.id
        ).toBe('red-ui-sidebar-ai-access');
        $('#ai-access-open-mcp').elements[0]!.handlers.click![0]!();
        expect(opened).toEqual(['/ai-access']);
        if (canEdit) {
          $('#ai-access-enabled').elements[0]!.props.checked = false;
          $('#ai-access-enabled').elements[0]!.handlers.change![0]!();
          await vi.advanceTimersByTimeAsync(0);
          const put = fetcher.mock.calls.find(
            call => (call[1] as { method?: string } | undefined)?.method === 'PUT'
          );
          expect(put).toBeDefined();
          // Partial PUT of sidebar-owned toggles only; locked oauth is omitted.
          expect(JSON.parse((put![1] as { body: string }).body)).toEqual({
            enabled: false,
            allowWithoutAdminAuth: false,
          });
        }
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('shows escaped OAuth route conflicts with reveal links and confirms an insecure Public URL', async () => {
    vi.useFakeTimers();
    try {
      const settings = { oauth: { enabled: false }, publicBaseUrl: '' };
      const fetcher = vi.fn(async (url: string, options?: { method?: string; body?: string }) => {
        let body: unknown = { canEdit: true, adminAuthEnabled: true, settings, sources: {} };
        if (url.endsWith('/oauth/status'))
          body = {
            authorization: ['/mcp/oauth/token (other plugin)'],
            metadata: [],
            details: [
              { kind: 'authorization', path: '/mcp/oauth/token', source: 'route', layer: 'x' },
              {
                kind: 'metadata',
                path: '/.well-known/oauth-authorization-server',
                source: 'http-in',
                nodeId: 'abc',
                nodeName: 'Meta in',
              },
              {
                kind: 'metadata',
                path: '/.well-known/oauth-<b>x</b>',
                source: 'http-in',
                nodeId: 'evil',
                nodeName: '<img src=x onerror=alert(1)>',
              },
            ],
            httpNodeRootFallback: true,
          };
        if (options?.method === 'PUT') Object.assign(settings, JSON.parse(options.body!));
        return { ok: true, text: async () => JSON.stringify(body) };
      });
      const { $, load } = runSidebar(fetcher);
      load();
      await vi.advanceTimersByTimeAsync(0);
      interface TextNode {
        tag?: string;
        textContent?: string;
        htmlContent?: string;
        children?: TextNode[];
        handlers?: Record<string, ((...a: unknown[]) => void)[]>;
      }
      const box = $('#ai-access-oauth-route-warning').elements[0]! as unknown as TextNode & {
        props: Record<string, unknown>;
      };
      expect(box.props.visible).toBe(true);
      const deepText = (el: TextNode): string =>
        (el.textContent ?? '') + (el.children ?? []).map(deepText).join('');
      const warningText = deepText(box);
      expect(warningText).toContain('OAuth route conflict');
      expect(warningText).toContain('already registered by another node or plugin');
      expect(warningText).toContain("http-in node 'Meta in'");
      expect(warningText).toContain("'<img src=x onerror=alert(1)>'");
      const tags: string[] = [];
      const html: string[] = [];
      const codes: string[] = [];
      const links: TextNode[] = [];
      const walk = (el: TextNode): void => {
        if (el.tag) tags.push(el.tag);
        if (el.tag === 'code') codes.push(el.textContent ?? '');
        if (el.tag === 'a') links.push(el);
        if (el.htmlContent) html.push(el.htmlContent);
        (el.children ?? []).forEach(walk);
      };
      walk(box);
      expect(codes).toEqual([
        '/mcp/oauth/token',
        '/.well-known/oauth-authorization-server',
        '/.well-known/oauth-<b>x</b>',
      ]);
      expect(tags).not.toContain('img');
      expect(tags).not.toContain('b');
      expect(html).toEqual([]);
      expect(links).toHaveLength(2);

      $('#ai-access-oauth-enabled').elements[0]!.props.checked = true;
      $('#ai-access-oauth-enabled').elements[0]!.handlers.change![0]!();
      await vi.advanceTimersByTimeAsync(0);
      expect($('#ai-access-dialog-message').elements[0]!.textContent).toContain('No Public URL');
      $('#ai-access-dialog-cancel').elements[0]!.handlers.click![0]!();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(false);
      expect($('#ai-access-oauth-enabled').elements[0]!.props.checked).toBe(false);
      $('#ai-access-oauth-enabled').elements[0]!.props.checked = true;
      $('#ai-access-oauth-enabled').elements[0]!.handlers.change![0]!();
      await vi.advanceTimersByTimeAsync(0);
      $('#ai-access-dialog-allow').elements[0]!.handlers.click![0]!();
      await vi.advanceTimersByTimeAsync(0);
      const put = fetcher.mock.calls.find(call => call[1]?.method === 'PUT');
      expect(JSON.parse(put![1]!.body!)).toEqual({
        enabled: true,
        allowWithoutAdminAuth: false,
        oauth: { enabled: true },
      });
      settings.oauth.enabled = false;
      settings.publicBaseUrl = 'http://node.example';
      load();
      await vi.advanceTimersByTimeAsync(0);
      $('#ai-access-oauth-enabled').elements[0]!.props.checked = true;
      $('#ai-access-oauth-enabled').elements[0]!.handlers.change![0]!();
      await vi.advanceTimersByTimeAsync(0);
      expect($('#ai-access-dialog-message').elements[0]!.textContent).toContain(
        'does not use HTTPS'
      );
      $('#ai-access-dialog-cancel').elements[0]!.handlers.click![0]!();
      await vi.advanceTimersByTimeAsync(0);
      settings.publicBaseUrl = 'http://localhost:1880';
      load();
      await vi.advanceTimersByTimeAsync(0);
      const putCount = fetcher.mock.calls.filter(call => call[1]?.method === 'PUT').length;
      $('#ai-access-oauth-enabled').elements[0]!.props.checked = true;
      $('#ai-access-oauth-enabled').elements[0]!.handlers.change![0]!();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(
        putCount + 1
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
