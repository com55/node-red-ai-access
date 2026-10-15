/**
 * Editor sidebar tab (ai-access.html) — RED.sidebar.addTab contract.
 *
 * Node-RED 4.x wraps content in #red-ui-sidebar-content and lists the tab
 * (by name) in the View menu / sidebar dropdown next to Information, Help, etc.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const htmlPath = join(root, 'ai-access.html');

/** Minimal jQuery-like chain used by ai-access.html. */
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

/** Extract the first inline script body without an HTML-filter regex (CodeQL). */
function extractInlineScript(html: string): string | null {
  const lower = html.toLowerCase();
  const open = lower.indexOf('<script');
  if (open < 0) return null;
  const openEnd = html.indexOf('>', open);
  if (openEnd < 0) return null;
  const close = lower.indexOf('</script', openEnd + 1);
  if (close < 0) return null;
  let closeEnd = close + '</script'.length;
  while (closeEnd < html.length && /\s/.test(html.charAt(closeEnd))) {
    closeEnd += 1;
  }
  if (html.charAt(closeEnd) !== '>') return null;
  return html.slice(openEnd + 1, close);
}

describe('ai-access.html sidebar tab', () => {
  it('registers RED.sidebar.addTab with content element and no userSettings', () => {
    const html = readFileSync(htmlPath, 'utf8');
    const scriptBody = extractInlineScript(html);
    expect(scriptBody).toBeTruthy();
    expect(html).toMatch(/RED\.sidebar\.addTab/);
    expect(html).not.toMatch(/RED\.userSettings\.add/);
    expect(html).toMatch(/#red-ui-sidebar-ai-access/);

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

    runInNewContext(scriptBody!, context);

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

  it('builds a content pane with enable, deploy, TTL, Save, and /mcp controls', () => {
    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toMatch(/ai-access-enabled/);
    expect(html).toMatch(/ai-access-allow-without/);
    expect(html).toMatch(/ai-access-deploy/);
    expect(html).toMatch(/ai-access-ttl/);
    expect(html).toMatch(/ai-access-save/);
    expect(html).toMatch(/Open \/mcp/);
    expect(html).toMatch(/canEdit|readonly|\*/);
  });
});
