import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { pageClientScript } from '../../src/plugin/page-client.js';

function harness() {
  const listeners: Record<string, (() => void)[]> = {};
  class Element {
    hidden = false;
    attrs: Record<string, string> = {};
    html = '';
    writes = 0;
    scrollTop = 0;
    textContent = '';
    classList = { toggle: vi.fn(), remove: vi.fn() };
    get innerHTML() {
      return this.html;
    }
    set innerHTML(value: string) {
      this.html = value;
      this.writes++;
    }
    getAttribute(key: string) {
      return this.attrs[key] ?? null;
    }
    setAttribute(key: string, value: string) {
      this.attrs[key] = value;
    }
    removeAttribute(key: string) {
      delete this.attrs[key];
    }
    querySelectorAll() {
      return [];
    }
    querySelector() {
      return new Element();
    }
    addEventListener = vi.fn();
    focus = vi.fn();
  }
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const on = (event: string, fn: () => void) => (listeners[event] ??= []).push(fn);
  const location = { hash: '#/proposals', pathname: '/ai-access', search: '' };
  let now = Date.now();
  const frames: (() => void)[] = [];
  const window = {
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn((_x: number, y: number) => {
      window.scrollY = y;
    }),
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    addEventListener: on,
  };
  const selected = element('selected');
  selected.setAttribute('data-tab', 'proposals');
  const document = {
    getElementById: element,
    querySelectorAll: () => [],
    querySelector: (selector: string) => (selector.startsWith('nav.tabs') ? selected : null),
    addEventListener: on,
    visibilityState: 'visible',
    activeElement: null,
    body: {},
    documentElement: element('html'),
  };
  const requests: string[] = [];
  const card = vi.fn(() => '<article>review</article>');
  const mount = vi.fn();
  let respond: (path: string) => unknown = () => ({ proposals: [] });
  const api = vi.fn((path: string) => {
    requests.push(path);
    return Promise.resolve(respond(path));
  });
  const out = runInNewContext(
    pageClientScript().replace(
      '  boot();',
      `
      aiOn = true;
      api = testApi; renderProposalCard = testCard; mountProposalVisual = testMount;
      applyStatus = function () {}; loadLogs = function () {};
      globalThis.out = {
        loadProposals, renderProposalsList, showProposalDetail, loadProposalDiff,
        selectTab, openProposalDetail, backToProposals, routeFromLocation,
        setRows: function (rows) { cachedProposals = rows; proposalsLoaded = true; },
        setState: function (id, state) { visualStates[id] = state; },
        state: function (id) { return visualStates[id]; },
        details: function (id) { return proposalDetails[id]; }
      };
      `
    ) + '\nglobalThis.out;',
    {
      document,
      window,
      location,
      history: {
        pushState: (_a: unknown, _b: string, url: string) => {
          location.hash = url.slice(url.indexOf('#'));
        },
        replaceState: (_a: unknown, _b: string, url: string) => {
          location.hash = url.slice(url.indexOf('#'));
        },
      },
      localStorage: { getItem: () => null },
      Date: class extends Date {
        static now() {
          return now;
        }
      },
      testApi: api,
      testCard: card,
      testMount: mount,
    }
  );
  return {
    out,
    element,
    location,
    requests,
    card,
    mount,
    window,
    frames,
    respond: (fn: typeof respond) => {
      respond = fn;
    },
    emit: (event: string) => listeners[event]?.forEach(fn => fn()),
    advance: () => {
      now += 6000;
    },
  };
}

const row = (id = 'p') => ({
  id,
  title: 'Update flow',
  status: 'pending',
  flowId: 'f',
  flowLabel: 'Flow',
  createdAt: '2026-01-01T12:00:00Z',
});
const proposal = (id = 'p') => ({
  ...row(id),
  payload: { flowId: 'f', flow: { nodes: [] } },
  baseFlow: { nodes: [] },
});
const diff = () => ({ summary: { added: 0, removed: 0, modified: 0, moved: 0 }, modified: [] });
function data(path: string) {
  if (path.includes('?status=pending')) return { proposals: [row()] };
  if (path.includes('?status=')) return { proposals: [] };
  if (path.endsWith('/diff')) return diff();
  if (path.startsWith('/flows/')) return { flow: { nodes: [] } };
  return proposal(path.split('/')[2]?.split('?')[0]);
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('proposal navigation and refresh performance', () => {
  it('hides detail on hashchange synchronously, before a microtask or pending network', async () => {
    const h = harness();
    h.out.setRows([row()]);
    h.location.hash = '#/proposals/p';
    h.respond(() => new Promise(() => undefined));
    h.out.routeFromLocation();
    expect(h.element('proposal-detail-page').hidden).toBe(false);
    h.location.hash = '#/proposals';
    h.emit('hashchange');
    expect(h.element('proposal-detail-page').hidden).toBe(true);
    expect(h.element('proposals-list').hidden).toBe(false);
    expect(h.element('proposals-list').innerHTML).toContain('proposal-card-compact');
    await settle();
    expect(h.card).not.toHaveBeenCalled();
  });

  it('tab selection hides an old detail before loaders can run', () => {
    const h = harness();
    h.location.hash = '#/proposals/p';
    h.out.selectTab('proposals', { skipHash: true });
    h.out.selectTab('status');
    expect(h.element('proposal-detail-page').hidden).toBe(true);
    h.out.selectTab('proposals');
    expect(h.element('proposal-detail-page').hidden).toBe(true);
    expect(h.element('proposals-list').hidden).toBe(false);
    expect(h.requests).toHaveLength(0);
  });

  it('back reuses cached DOM and scroll on the same turn without awaiting data', async () => {
    const h = harness();
    h.out.setRows([row()]);
    h.out.renderProposalsList();
    const list = h.element('proposals-list');
    const writes = list.writes;
    h.window.scrollY = 330;
    h.out.openProposalDetail('p');
    // Model the browser's hash setter.
    h.location.hash = '#/proposals/p';
    h.out.selectTab('proposals', { skipHash: true });
    h.respond(() => new Promise(() => undefined));
    h.window.scrollY = 850;
    h.out.backToProposals();
    expect(h.element('proposal-detail-page').hidden).toBe(true);
    expect(list.hidden).toBe(false);
    expect(list.writes).toBe(writes);
    expect(h.requests).toHaveLength(2);
    h.frames.splice(0).forEach(fn => fn());
    expect(h.window.scrollY).toBe(330);
    await settle();
    expect(list.writes).toBe(writes);
  });

  it('back shows a placeholder immediately when rows have never loaded', () => {
    const h = harness();
    h.respond(() => new Promise(() => undefined));
    h.location.hash = '#/proposals/p';
    h.out.backToProposals();
    expect(h.element('proposal-detail-page').hidden).toBe(true);
    expect(h.element('proposals-list').hidden).toBe(false);
    expect(h.element('proposals-list').innerHTML).toContain('Loading proposals');
  });

  it('coalesces list loads and fetches pending and decided concurrently', async () => {
    const h = harness();
    const gates: ((value: unknown) => void)[] = [];
    h.respond(() => new Promise(resolve => gates.push(resolve)));
    const first = h.out.loadProposals();
    const second = h.out.loadProposals();
    expect(first).toBe(second);
    expect(h.requests).toHaveLength(2);
    gates[0]!({ proposals: [row()] });
    gates[1]!({ proposals: [] });
    await first;
    expect(h.element('proposals-list').writes).toBe(1);
    expect(h.requests.some(path => path === '/flows' || path.startsWith('/node-types'))).toBe(
      false
    );
  });

  it('opens detail once across tab load, hash events, and overlapping calls', async () => {
    const h = harness();
    h.out.setRows([row()]);
    h.respond(data);
    h.location.hash = '#/proposals/p';
    h.emit('hashchange');
    const first = h.out.showProposalDetail('p');
    const second = h.out.showProposalDetail('p');
    const diffLoad = h.out.loadProposalDiff('p');
    expect(first).toBe(second);
    h.emit('popstate');
    await Promise.all([first, diffLoad]);
    await settle();
    await h.out.showProposalDetail('p');
    expect(h.requests.filter(path => path.includes('include=payload'))).toHaveLength(1);
    expect(h.requests.filter(path => path.endsWith('/diff'))).toHaveLength(1);
    expect(h.card).toHaveBeenCalledTimes(1);
    expect(h.mount).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale detail and diff after navigating away', async () => {
    const h = harness();
    h.out.setRows([row()]);
    const gates: (() => void)[] = [];
    h.respond(path => new Promise(resolve => gates.push(() => resolve(data(path)))));
    h.location.hash = '#/proposals/p';
    h.out.selectTab('proposals', { skipHash: true });
    const loading = h.out.showProposalDetail('p');
    h.out.backToProposals();
    gates.splice(0).forEach(resolve => resolve());
    await loading;
    await settle();
    expect(h.element('proposal-detail-page').hidden).toBe(true);
    expect(h.out.details('p')).toBeUndefined();
    expect(h.card).not.toHaveBeenCalled();
    expect(h.mount).not.toHaveBeenCalled();
  });

  it.each(['focus', 'visibilitychange'])(
    '%s silently refreshes unchanged detail without replacing DOM or visual state',
    async event => {
      const h = harness();
      h.out.setRows([row()]);
      h.respond(data);
      h.location.hash = '#/proposals/p';
      h.emit('hashchange');
      await settle();
      const host = h.element('proposal-detail-page');
      const writes = host.writes;
      const state = { selected: 'node', view: { k: 1.7, x: 50, y: -35 }, showAll: false };
      h.out.setState('p', state);
      h.window.scrollY = 700;
      h.advance();
      h.emit(event);
      await settle();
      expect(h.requests.filter(path => path.includes('include=payload'))).toHaveLength(2);
      expect(host.writes).toBe(writes);
      expect(h.card).toHaveBeenCalledTimes(1);
      expect(h.mount).toHaveBeenCalledTimes(1);
      expect(h.out.state('p')).toBe(state);
      expect(h.window.scrollY).toBe(700);
    }
  );

  it('an unrelated list update on focus does not rebuild the open detail', async () => {
    const h = harness();
    h.out.setRows([row()]);
    h.respond(data);
    h.location.hash = '#/proposals/p';
    h.emit('hashchange');
    await settle();
    h.respond(path =>
      path.includes('?status=pending') ? { proposals: [row(), row('other')] } : data(path)
    );
    h.advance();
    h.emit('focus');
    await settle();
    expect(h.card).toHaveBeenCalledTimes(1);
    expect(h.mount).toHaveBeenCalledTimes(1);
  });

  it('reopening cached detail revalidates once without rendering unchanged data', async () => {
    const h = harness();
    h.out.setRows([row()]);
    h.respond(data);
    h.location.hash = '#/proposals/p';
    h.emit('hashchange');
    await settle();
    h.out.backToProposals();
    await settle();
    h.location.hash = '#/proposals/p';
    h.emit('hashchange');
    await settle();
    expect(h.requests.filter(path => path.includes('include=payload'))).toHaveLength(2);
    expect(h.card).toHaveBeenCalledTimes(1);
  });

  it('a post-action detail refresh supersedes an older detail and diff request', async () => {
    const h = harness();
    h.out.setRows([row()]);
    const gates: ((fresh?: boolean) => void)[] = [];
    h.respond(
      path =>
        new Promise(resolve =>
          gates.push(fresh => {
            const result = data(path);
            resolve(
              path.includes('include=payload')
                ? { ...result, title: fresh ? 'Fresh' : 'Old' }
                : result
            );
          })
        )
    );
    h.location.hash = '#/proposals/p';
    h.out.selectTab('proposals', { skipHash: true });
    const old = h.out.showProposalDetail('p');
    const fresh = h.out.showProposalDetail('p', { refresh: true, force: true });
    expect(h.requests.filter(path => path.endsWith('/diff'))).toHaveLength(2);
    gates.splice(3).forEach(resolve => resolve(true));
    await fresh;
    gates.forEach(resolve => resolve(false));
    await old;
    expect(h.out.details('p').title).toBe('Fresh');
    expect(h.card).toHaveBeenCalledTimes(1);
  });

  it('refreshes changed detail exactly once and keeps the visual state object', async () => {
    const h = harness();
    h.out.setRows([row()]);
    h.respond(data);
    h.location.hash = '#/proposals/p';
    h.emit('hashchange');
    await settle();
    const state = { selected: 'node', view: { k: 1.5, x: 10, y: 20 } };
    h.out.setState('p', state);
    h.respond(path => {
      const result = data(path);
      return path.endsWith('/diff') ? { ...result, currentRev: 'changed' } : result;
    });
    await h.out.loadProposals({ auto: true });
    expect(h.card).toHaveBeenCalledTimes(2);
    expect(h.mount).toHaveBeenCalledTimes(2);
    expect(h.out.state('p')).toBe(state);
  });
});
