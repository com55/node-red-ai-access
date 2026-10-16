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

import { describe, expect, it } from 'vitest';

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
          if (name === 'id') el.id = value;
          if (name === 'class') el.className = value;
        }
        return api;
      },
      text(value?: string) {
        if (value === undefined) return els[0]?.textContent ?? '';
        for (const el of els) el.textContent = value;
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
          for (const el of els) target.children.push(el);
        }
        return api;
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
      toggle() {
        return api;
      },
      toggleClass() {
        return api;
      },
      is() {
        return false;
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

  it('auto-saves only (no Save), friendly deploy labels, Refresh in header', () => {
    const js = renderEditorSidebarJs();
    expect(js).toMatch(/scheduleAutoSave/);
    expect(js).toMatch(/Changes apply immediately \(no restart\)/);
    expect(js).not.toMatch(/ai-access-save/);
    expect(js).not.toMatch(/\.text\('Save'\)/);
    expect(js).toMatch(/Only changed nodes \(recommended\)/);
    expect(js).toMatch(/Changed flows/);
    expect(js).toMatch(/Full redeploy/);
    expect(js).not.toMatch(/nodes = only changed nodes restart/);
    expect(js).toMatch(/ai-access-refresh/);
    expect(js).toMatch(/Open AI Access dashboard/);
    expect(js).toMatch(/ai-access-ttl-presets|data-hours/);
    expect(js).toMatch(/canEdit|readonly|\*/);
    expect(js).toMatch(/red-ui-settings-row stacked/);
    expect(js).toMatch(/flex-wrap:\s*nowrap/);
    expect(js).toMatch(new RegExp(`v=${EDITOR_SIDEBAR_ASSET_VERSION}`));
    expect(js).toMatch(/showSavedToast|Saved/);
  });
});
