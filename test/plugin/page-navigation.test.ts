import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { pageClientScript } from '../../src/plugin/page-client.js';
import { initialTabFromHash, tabFromHash } from '../../src/plugin/page-hash.js';
import { renderMcpPage } from '../../src/plugin/page.js';

describe('settings navigation', () => {
  it('renders a sticky header and mobile drawer with the same local navigation icons', () => {
    const html = renderMcpPage({
      apiBase: '/mcp/api/v1',
      editorRoot: '/',
      authTokenKey: 'auth-tokens',
    });
    const header = /<header class="dashboard-header"[\s\S]*?<\/header>/.exec(html)![0];
    const drawer = /<aside id="mobile-menu"[\s\S]*?<\/aside>/.exec(html)![0];
    expect(header.indexOf('id="menu-toggle"')).toBeLessThan(
      header.indexOf('class="dashboard-brand"')
    );
    expect(header).toContain('AI Access</span>');
    expect(header).toContain('aria-controls="mobile-menu" aria-expanded="false"');
    expect(header).toContain('id="proposals-pending-badge"');
    expect(header).toContain('aria-label="Settings" title="Settings"');
    expect(header).toContain('aria-label="Audit log" title="Audit log"');
    expect(drawer).toContain('role="dialog" aria-modal="true"');
    expect(drawer).toContain('<hr class="utility-divider">');
    expect(html).toContain('id="menu-scrim" hidden');
    for (const markup of [header, drawer]) {
      const items = [...markup.matchAll(/<button[^>]*data-tab="([^"]+)"[\s\S]*?<\/button>/g)];
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
      }
    }
    const paths = (markup: string) => [...markup.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
    expect(paths(header).slice(-6)).toEqual(paths(drawer));
    expect(html).not.toContain('nav-group-title');
    expect(html).not.toContain('grid-template-columns: 220px');
    expect(html).toContain('.dashboard-header { position: sticky; top: 0;');
    expect(html).toContain('@media (max-width: 850px)');
    expect(html).toContain('section.panel h2:focus { outline: none; }');
    expect(html).toContain(
      'section.panel h2:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }'
    );
  });

  it('measures the sticky header initially and when its size changes', () => {
    const script = pageClientScript();
    const setup = script.slice(
      script.indexOf('  function setupStickyNav()'),
      script.indexOf('  function openProposalDetail(')
    );
    let height = 68;
    const header = { getBoundingClientRect: () => ({ height }) };
    const setProperty = vi.fn(),
      observe = vi.fn();
    const resize: Record<string, () => void> = {};
    let observedResize: () => void = vi.fn();
    runInNewContext(setup + '\nsetupStickyNav();', {
      document: { querySelector: () => header, documentElement: { style: { setProperty } } },
      window: {
        addEventListener: (event: string, fn: () => void) => {
          resize[event] = fn;
        },
      },
      ResizeObserver: class {
        constructor(fn: () => void) {
          observedResize = fn;
        }
        observe = observe;
      },
    });
    expect(setProperty).toHaveBeenLastCalledWith('--nav-height', '88px');
    expect(observe).toHaveBeenCalledWith(header);
    height = 80;
    resize.resize();
    expect(setProperty).toHaveBeenLastCalledWith('--nav-height', '100px');
    height = 90;
    observedResize();
    expect(setProperty).toHaveBeenLastCalledWith('--nav-height', '110px');
  });

  it('hides both split controls on narrow screens and keeps shared visual styles in the base CSS', () => {
    const html = renderMcpPage({ apiBase: '/mcp/api/v1' });
    const media = [...html.matchAll(/@media \(max-width: 699px\) \{([^}]+}[^}]*})/g)];
    expect(media).toHaveLength(2);
    for (const match of media)
      expect(match[1]).toContain('button[data-conflict-diff-mode="split"] { display: none; }');
    for (const selector of [
      '.visual-eyebrow {',
      '.visual-detail-counts {',
      '.visual-detail-counts span {',
    ])
      expect(html.split('\n').filter(line => line.startsWith(selector))).toHaveLength(1);
  });

  it('uses thin accent rings only for visible focus on dashboard controls', () => {
    const html = renderMcpPage({
      apiBase: '/mcp/api/v1',
      editorRoot: '/',
      authTokenKey: 'auth-tokens',
    });
    expect(html).toContain(
      '.settings-layout :is(button, summary, [role="button"]):focus { outline: none; }'
    );
    expect(html).toContain(
      '.settings-layout :is(button, summary, [role="button"]):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }'
    );
    // The ID-copy button must not override the shared pointer-focus reset.
    expect(html).not.toMatch(/button\.id-copy:focus\s*\{[^}]*outline:/);
    expect(html).toContain('section.panel h2:focus { outline: none; }');
    expect(html).not.toMatch(/section\.panel > h2:focus\s*\{[^}]*outline:\s*(?!none)[0-9]/);
  });

  it('keeps form rows and filters left-aligned with responsive token fields', () => {
    const html = renderMcpPage({
      apiBase: '/mcp/api/v1',
      editorRoot: '/',
      authTokenKey: 'auth-tokens',
    });
    const script = pageClientScript();
    expect(script).toContain('<div class="row token-create-row">');
    expect(script).toMatch(
      /<div class="row token-create-row">(?:(?!<\/div><div class="row)[\s\S])*<label>Label \(optional\)<input[^>]*\/><\/label>'\s*\+\s*'<button type="submit" class="action">Create access token<\/button><\/div>/
    );
    expect(script).not.toContain('token-create-actions');
    expect(script).not.toContain('style="align-items:flex-end"');
    expect(html).toMatch(/\.row \{[^}]*justify-content: flex-start;/);
    expect(html).toMatch(/\.filter-row \{[^}]*justify-content: flex-start;/);
    expect(html).toContain(
      'section.panel:not(#section-proposals) .row { flex-direction: column; align-items: flex-start; }'
    );
    expect(html).toContain(
      'section.panel#section-links .row.token-create-row { flex-direction: row; flex-wrap: wrap; gap: 0.55rem; justify-content: flex-start; align-items: flex-end; }'
    );
    expect(html).toMatch(
      /@media \(max-width: 600px\) \{\s*section\.panel#section-links \.row\.token-create-row \{ flex-direction: column; align-items: flex-start; \}/
    );
    // :not() contributes its argument's specificity. Source order alone cannot
    // make the old #section-links .token-create-row selector beat the settings rule.
    const specificity = (selector: string) => {
      const expanded = selector.replace(/\/\*[\s\S]*?\*\//g, '').replace(/:not\(([^)]+)\)/g, '$1');
      return [
        (expanded.match(/#[\w-]+/g) ?? []).length,
        (expanded.match(/\.[\w-]+/g) ?? []).length,
        (expanded.match(/(?:^|\s)[a-z]+/g) ?? []).length,
      ];
    };
    const settingsSelector = /([^{}]+)\{ flex-direction: column; align-items: flex-start; \}/
      .exec(html)![1]
      .trim();
    const tokenSelector = /([^{}]+)\{ flex-direction: row; flex-wrap: wrap; gap: 0.55rem;/
      .exec(html)![1]
      .trim();
    expect(specificity(settingsSelector)).toEqual([1, 2, 1]);
    expect(specificity(tokenSelector)).toEqual([1, 3, 1]);
    expect(html).toContain(
      '.token-create-row > label, .token-create-row > button { flex: 0 0 auto; max-width: 100%; }'
    );
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

  it.each(['#proposal=deep', '#proposal=deep&tab=review', '#/proposals/deep', '#/proposals/deep/'])(
    'keeps the detail URL persistent for %s',
    hash => {
      const script = pageClientScript();
      const tabs = script.slice(
        script.indexOf('  // Hash helpers'),
        script.indexOf('  var TTL_PRESET_15M')
      );
      const focus = script.slice(
        script.indexOf('  function readProposalHashId()'),
        script.indexOf('  function bindDiffModeToggle(')
      );
      const location = { hash, pathname: '/ai-access', search: '' };
      const renderProposalsList = vi.fn();
      const context = {
        cancelPublicUrlPoll: vi.fn(),
        location,
        document: { querySelectorAll: () => [] },
        window: { scrollTo: vi.fn() },
        renderProposalsList,
      };
      runInNewContext(tabs + focus, context);
      expect(runInNewContext('focusProposalFromHash()', context)).toBe(true);
      expect(renderProposalsList).toHaveBeenCalledOnce();
      expect(location.hash).toBe(hash);
      expect(context.window.scrollTo).not.toHaveBeenCalled();
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
    const animationFrames: (() => void)[] = [];
    let scrollY = 0;
    const scrollTo = vi.fn((_x: number, y: number) => {
      scrollY = y;
    });
    const flushAnimationFrames = () => {
      animationFrames.splice(0).forEach(callback => callback());
    };
    const context = {
      cancelPublicUrlPoll: vi.fn(),
      closeDashboardMenu: vi.fn(),
      proposalListScroll: 0,
      location,
      history: {
        scrollRestoration: 'auto',
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
        requestAnimationFrame(callback: () => void) {
          animationFrames.push(callback);
        },
        addEventListener(event: string, callback: () => void) {
          listeners[event] = callback;
        },
      },
      authGateShown: false,
      loadSettings: vi.fn(),
      loadOAuthTab: vi.fn(),
      loadLinks: vi.fn(),
      renderProposalsList: vi.fn(),
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
    expect(context.history.scrollRestoration).toBe('manual');
    buttons[1].click();
    expect(focusHeading).toHaveBeenCalledExactlyOnceWith('links', { preventScroll: true });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
    flushAnimationFrames();
    expect(scrollY).toBe(0);
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
      // Model a late browser scroll restoration/fragment jump after dispatch.
      scrollY = 350;
      flushAnimationFrames();
      expect(scrollY).toBe(0);
      expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
      expect(panels.filter(p => p.active).map(p => p.id)).toEqual(['section-' + expected]);
      expect(
        buttons.filter(b => b.attrs['aria-current'] === 'page').map(b => b.attrs['data-tab'])
      ).toEqual([expected]);
    }
    for (const hash of ['#proposal=first', '#proposal=second']) {
      location.hash = hash;
      scrollTo.mockClear();
      scrollY = 700;
      const loads = context.loadProposals.mock.calls.length;
      context.readProposalHashId = () => hash.slice('#proposal='.length);
      listeners.popstate();
      listeners.hashchange();
      expect(context.loadProposals).toHaveBeenCalledTimes(loads + 1);
      expect(focusHeading).toHaveBeenLastCalledWith('proposals', { preventScroll: true });
      expect(scrollTo).not.toHaveBeenCalled();
      expect(animationFrames).toHaveLength(0);
      flushAnimationFrames();
      expect(scrollY).toBe(700);
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
