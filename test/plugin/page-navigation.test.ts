import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

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
    const nav = html.match(/<nav class="tabs"[\s\S]*?<\/nav>/)![0];
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
    expect(nav).toContain('id="proposals-pending-badge"');
    expect(html).toContain('@media (max-width: 768px)');
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
      attrs: { 'data-tab': id } as Record<string, string>,
      click: () => {},
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
    const panels = ids.map(id => ({
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
        addEventListener(event: string, callback: () => void) {
          listeners[event] = callback;
        },
      },
      authGateShown: false,
      loadSettings() {},
      loadOAuthTab() {},
      loadLinks() {},
      loadProposals() {},
      loadLogs() {},
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
      listeners[event]();
      expect(panels.filter(p => p.active).map(p => p.id)).toEqual(['section-' + expected]);
      expect(
        buttons.filter(b => b.attrs['aria-current'] === 'page').map(b => b.attrs['data-tab'])
      ).toEqual([expected]);
    }
  });
});
