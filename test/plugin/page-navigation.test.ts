import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { pageClientScript } from '../../src/plugin/page-client.js';
import { initialTabFromHash, tabFromHash } from '../../src/plugin/page-hash.js';
import { renderMcpPage } from '../../src/plugin/page.js';

describe('settings navigation', () => {
  it('renders grouped navigation with local, theme-aware icons and preserved controls', () => {
    const html = renderMcpPage({
      apiBase: '/mcp/api/v1',
      editorRoot: '/',
      authTokenKey: 'auth-tokens',
    });
    const nav = /<nav class="tabs"[\s\S]*?<\/nav>/.exec(html)![0];
    expect([...nav.matchAll(/class="nav-group-title"[^>]*>([^<]+)/g)].map(m => m[1])).toEqual([
      'Overview',
      'Access',
      'Proposals',
      'Advanced',
    ]);
    const items = [...nav.matchAll(/<button[^>]*data-tab="([^"]+)"[\s\S]*?<\/button>/g)];
    expect(items.map(m => m[1])).toEqual([
      'status',
      'links',
      'oauth',
      'proposals',
      'settings',
      'logs',
    ]);
    for (const item of items) {
      expect(item[0]).toContain('aria-controls="section-' + item[1] + '"');
      expect(item[0]).toMatch(/<svg[^>]*width="16"[^>]*fill="currentColor"/);
      expect(item[0]).toContain('aria-hidden="true"');
      expect(item[0]).not.toMatch(/<use|src=|https?:/);
      expect(html).toContain('id="section-' + item[1] + '"');
    }
    expect(nav).not.toContain('aria-selected');
    expect(nav).not.toContain('<h2');
    for (const label of ['overview', 'proposals']) {
      expect(nav).toContain(`id="nav-group-${label}" aria-hidden="true"`);
      expect(nav).not.toContain(`aria-labelledby="nav-group-${label}"`);
    }
    for (const label of ['access', 'advanced']) {
      expect(nav).toContain(`role="group" aria-labelledby="nav-group-${label}"`);
    }
    expect(html.match(/<h2 tabindex="-1">/g)).toHaveLength(6);
    expect(html).toContain('grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)');
    expect(html).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)');
    expect(nav).toContain('id="proposals-pending-badge"');
    expect(html).toContain('@media (max-width: 768px)');
  });

  it('keeps form rows and filters left-aligned with responsive token fields', () => {
    const html = renderMcpPage({
      apiBase: '/mcp/api/v1',
      editorRoot: '/',
      authTokenKey: 'auth-tokens',
    });
    const script = pageClientScript();
    expect(script).toContain('<div class="row token-create-row">');
    expect(script).not.toContain('style="align-items:flex-end"');
    expect(html).toMatch(/\.row \{[^}]*justify-content: flex-start;/);
    expect(html).toMatch(/\.filter-row \{[^}]*justify-content: flex-start;/);
    expect(html).toContain(
      'section.panel:not(#section-proposals) .row { flex-direction: column; align-items: flex-start; }'
    );
    expect(html).toContain(
      '#section-links .token-create-row { flex-direction: row; align-items: flex-end; }'
    );
    expect(html).toMatch(
      /@media \(max-width: 640px\) \{\s*#section-links \.token-create-row \{ flex-direction: column; align-items: flex-start; \}/
    );
    expect(html).toContain('flex: 0 0 auto; max-width: 100%');
    expect(html).toContain('#link-label { width: 16rem; }');
    expect(html).toContain('.logs-toolbar .debug-toggle { margin-left: 0; }');
  });

  it.each(['status', 'links', 'settings', 'oauth', 'proposals', 'logs'])(
    'accepts section hash alias %s',
    id => {
      expect(tabFromHash('#section-' + id)).toBe(id);
      expect(initialTabFromHash('#section-' + id)).toBe(id);
    }
  );

  it('routes clicks, hashes and back/forward through the actual client script', () => {
    const ids = ['status', 'links', 'settings', 'oauth', 'proposals', 'logs'];
    const buttons = ids.map(id => ({
      attrs: { 'data-tab': id },
      click: () => {
        // Replaced by the click listener when the client script initializes.
      },
      getAttribute(key: string) {
        return this.attrs[key];
      },
      setAttribute(key: string, value: string) {
        this.attrs[key] = value;
      },
      addEventListener(_event: string, callback: () => void) {
        this.click = callback;
      },
    }));
    const focusHeading = vi.fn();
    const panels = ids.map(id => ({
      querySelector: () => ({ focus: (options: unknown) => focusHeading(id, options) }),
      id: 'section-' + id,
      active: false,
      classList: {
        toggle(_name: string, active: boolean) {
          panels.find(p => p.id === 'section-' + id)!.active = active;
        },
      },
    }));
    const listeners: Record<string, () => void> = {};
    const location = { hash: '', pathname: '/ai-access', search: '' };
    const historyEntries: string[] = [];
    const scrollTo = vi.fn();
    const context = {
      location,
      history: {
        pushState(_a: unknown, _b: string, url: string) {
          historyEntries.push(url);
          location.hash = url.slice(url.indexOf('#'));
        },
        replaceState(_a: unknown, _b: string, url: string) {
          location.hash = url.slice(url.indexOf('#'));
        },
      },
      document: {
        querySelectorAll(selector: string) {
          if (selector === 'nav.tabs button') return buttons;
          if (selector === 'section.panel') return panels;
          return [];
        },
      },
      window: {
        scrollTo,
        addEventListener(event: string, callback: () => void) {
          listeners[event] = callback;
        },
      },
      authGateShown: false,
      loadSettings: vi.fn(),
      loadOAuthTab: vi.fn(),
      loadLinks: vi.fn(),
      loadProposals: vi.fn(),
      loadLogs: vi.fn(),
      readProposalHashId() {
        return '';
      },
    };
    const script = pageClientScript();
    const tabs = script.slice(
      script.indexOf('  // Hash helpers'),
      script.indexOf('  var TTL_PRESET_15M')
    );
    const routes = script.slice(
      script.indexOf('  function routeFromLocation()'),
      script.indexOf("  window.addEventListener('popstate', routeFromLocation);") +
        "  window.addEventListener('popstate', routeFromLocation);".length
    );
    runInNewContext(tabs + routes, context);
    buttons[1].click();
    expect(focusHeading).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(location.hash).toBe('#links');
    expect(historyEntries).toEqual(['/ai-access#links']);
    expect(buttons[1].attrs['aria-current']).toBe('page');
    expect(panels.filter(p => p.active).map(p => p.id)).toEqual(['section-links']);
    for (const [hash, expected, event] of [
      ['#audit', 'logs', 'hashchange'],
      ['#section-oauth', 'oauth', 'popstate'],
      ['#unknown', 'status', 'hashchange'],
      ['', 'status', 'popstate'],
      ['#overview', 'status', 'popstate'],
      ['#tokens', 'links', 'hashchange'],
    ]) {
      location.hash = hash;
      focusHeading.mockClear();
      scrollTo.mockClear();
      listeners[event]();
      const focusCount = focusHeading.mock.calls.length;
      const scrollCount = scrollTo.mock.calls.length;
      const oauthLoads = context.loadOAuthTab.mock.calls.length;
      listeners.hashchange();
      listeners.popstate();
      expect(focusHeading).toHaveBeenCalledTimes(focusCount);
      expect(context.loadOAuthTab).toHaveBeenCalledTimes(oauthLoads);
      expect(scrollTo).toHaveBeenCalledTimes(scrollCount);
      if (focusCount) {
        expect(focusHeading).toHaveBeenLastCalledWith(expected, { preventScroll: true });
        expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
        expect(focusHeading.mock.invocationCallOrder.at(-1)).toBeLessThan(
          scrollTo.mock.invocationCallOrder.at(-1)!
        );
      }
      expect(panels.filter(p => p.active).map(p => p.id)).toEqual(['section-' + expected]);
      expect(
        buttons.filter(b => b.attrs['aria-current'] === 'page').map(b => b.attrs['data-tab'])
      ).toEqual([expected]);
    }
    for (const hash of ['#proposal=first', '#proposal=second']) {
      location.hash = hash;
      const loads = context.loadProposals.mock.calls.length;
      context.readProposalHashId = () => hash.slice('#proposal='.length);
      listeners.popstate();
      listeners.hashchange();
      expect(context.loadProposals).toHaveBeenCalledTimes(loads + 1);
      expect(focusHeading).toHaveBeenLastCalledWith('proposals', { preventScroll: true });
    }
    focusHeading.mockClear();
    location.hash = '#oauth';
    const initialRoute = script.slice(
      script.indexOf('      var initialTab = initialTabFromHash'),
      script.indexOf("      if (initialTab === 'settings')")
    );
    runInNewContext(initialRoute, context);
    expect(focusHeading).toHaveBeenCalledExactlyOnceWith('oauth', { preventScroll: true });
  });
});
