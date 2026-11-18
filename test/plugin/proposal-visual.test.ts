import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { applyDiffFormat } from '../../src/plugin/diff-format.js';
import { PRESENCE_SHORT_TEXT_MAX } from '../../src/plugin/diff-ui.js';
import { diffLines } from '../../src/plugin/line-diff.js';
import { pageClientVisualGeometryScript } from '../../src/plugin/page-client-visual.js';
import { pageClientScript } from '../../src/plugin/page-client.js';
import { pageStyles } from '../../src/plugin/page-styles.js';
import {
  changedNodeKeys,
  flowChangeCounts,
  isMoveOnly,
  proposalChangeCounts,
} from '../../src/plugin/proposal-changes.js';
import { buildDiffSections } from '../../src/plugin/proposal-diff.js';
import { presentProposalForApi } from '../../src/plugin/proposal-present.js';
import type { FlowNode } from '../../src/runtime/types.js';
import type { Proposal } from '../../src/storage/proposals.js';

function browserHelpers(
  elements: Record<string, any> = {},
  articles: any[] = [],
  matchMedia?: (query: string) => { matches: boolean },
  resizeObserver?: any,
  environment: { canvas?: any; red?: any; editorRoot?: string } = {}
) {
  const preferences = new Map<string, string>();
  const context = {
    ResizeObserver: resizeObserver,
    document: {
      createElement: environment.canvas
        ? () => ({ getContext: () => environment.canvas })
        : undefined,
      getElementById: (id: string) =>
        id === 'mcp-root'
          ? { getAttribute: () => JSON.stringify({ editorRoot: environment.editorRoot }) }
          : (elements[id] ?? {
              addEventListener: vi.fn(),
              setAttribute: vi.fn(),
              removeAttribute: vi.fn(),
              querySelectorAll: () => [],
              querySelector: () => null,
              getAttribute: () => null,
            }),
      querySelector: (selector: string) => elements[selector] ?? null,
      querySelectorAll: (selector: string) => (selector === '.proposal-detail' ? articles : []),
      addEventListener: vi.fn(),
    },
    window: { addEventListener: vi.fn(), matchMedia, RED: environment.red },
    location: { hash: '#proposals' },
    localStorage: {
      getItem: (key: string) => preferences.get(key),
      setItem: (key: string, value: string) => preferences.set(key, value),
    },
  };
  return runInNewContext(
    pageClientScript().replace(
      '  boot();',
      `
    globalThis.ui = {
      visualGraph, visualVisible, visualGroupBoxes, visualGroupMarkup, visualToggleRun, visualNodeSvg, visualMarkup, visualTextWidth, visualIconEvent, visualIconUrls, renderCompactProposal, renderProposalCard,
      mountProposalVisual, statusIcon, renderHumanDiff, renderVisualNodeDrawer, renderPropertyChange, renderConflictValues, visualDetailsEscape, getDiffMode, setDiffMode,
      setConflictValues: function (id, values) { proposalConflictValues[id] = values; },
      setHash: function (hash) { location.hash = hash; },
      buildDisambiguatedTitles, syncProposalRoute, setViewport: function (width) { window.innerWidth = width; window.matchMedia = function () { return { matches: width >= 700 }; }; }, displayTitleForProposal, diffComparisonKey,
      proposalMatchesFilter, renderChangeCounts, renderReviewActionRow, approveProposal,
      settleSearchAfterAction, bindReviewControls, proposalForReview, doApproveProposal, rejectProposal,
      renderProposalsList, renderDecidedLoadMore, bindCrossTabHint, countSearchMatchesInFilter,
      setSearch: function (filter, query, proposals, more) { proposalsFilter = filter; proposalsSearchQuery = query; proposalsLoaded = true; cachedProposals = proposals; decidedHasMore = more; },
      setTypeMetadata: function (type, meta) { visualTypeMetadata[type] = meta; },
      setApi: function (fn) { api = fn; },
      setDetails: function (p) { proposalDetails[p.id] = p; },
      setAction: function (approve, reject) { doApproveProposalInner = approve; rejectProposalInner = reject; },
      setupDialogs,
      pendingCount: function () { return proposalActionsInFlight; },
      getFilter: function () { return proposalsFilter; },
      setListState: function (filter, query, hash) { proposalsFilter = filter; proposalsSearchQuery = query; location.hash = hash; renderProposalsList = function () {}; },
      getListState: function () { return [proposalsFilter, proposalsSearchQuery]; },
      setPermission: function (v) { canApprove = v; },
      setDefault: function (v) { defaultDeploy = v; },
      setDiff: function (p, d) { cachedProposals = [p]; proposalDiffCache[p.id] = d; },
      setDeploy: function (id, v) { proposalDeployTypes[id] = v; },
      setApprove: function (fn) { doApproveProposal = fn; }
    };
  `
    ) + '\nglobalThis.ui;',
    context
  );
}

function chain(changed: number[], length = 9) {
  const before = {
    nodes: Array.from({ length }, (_, i) => ({
      id: 'n' + i,
      type: 'function',
      x: 100 + i * 180,
      y: 100,
      func: 'return msg;',
      wires: i === length - 1 ? [] : [['n' + (i + 1)]],
    })),
  };
  const after = {
    nodes: before.nodes.map((n, i) =>
      changed.includes(i) ? { ...n, func: 'msg.payload = true;\nreturn msg;' } : { ...n }
    ),
  };
  const p = { id: 'p', baseFlow: before, payload: { flowId: 'tab', flow: after } };
  return { p, diff: buildDiffSections(after, before) };
}

function viewState() {
  return {
    layout: 'compact',
    expanded: {},
    positions: {},
    displacements: {},
    anchors: {},
    view: { x: 37, y: 29, k: 0.75 },
  };
}

const centres = (visible: any) => visible.nodes.map((n: any) => [n.id, n.px, n.py]);

describe('Visual View groups', () => {
  it('draws styled boxes around members in Compact and Editor positions without a group band', () => {
    const ui = browserHelpers();
    const first = { id: 'a', type: 'inject', x: 100, y: 120, wires: [['b']] };
    const second = { id: 'b', type: 'function', x: 300, y: 120, wires: [], func: 'old' };
    const group = {
      id: 'g',
      type: 'group',
      name: 'Example',
      nodes: ['a', 'b'],
      style: { stroke: '#123456', fill: '#abcdef', 'fill-opacity': 0, color: '#654321' },
    };
    const baseFlow = { nodes: [group, first, second] };
    const flow = { nodes: [group, first, { ...second, func: 'new' }] };
    const visualLiveFlow = {
      nodes: [group, { ...first, x: 150, y: 220 }, { ...second, x: 350, y: 220 }],
    };
    const graph = ui.visualGraph(
      { baseFlow, payload: { flow }, visualLiveFlow },
      { modified: [{ id: 'b' }, { id: 'g' }] }
    );
    const compact = ui.visualVisible(graph, viewState());
    expect(compact.nodes.map((n: any) => n.type)).not.toContain('group');
    expect(compact.nodes.map((n: any) => n.py)).toEqual([110, 110]);
    const box = ui.visualGroupBoxes(compact, graph.groups)[0];
    for (const node of compact.nodes) {
      expect(box.x - box.w / 2).toBeLessThan(node.px - node.w / 2);
      expect(box.x + box.w / 2).toBeGreaterThan(node.px + node.w / 2);
      expect(box.y - box.h / 2).toBeLessThan(node.py - node.h / 2);
      expect(box.y + box.h / 2).toBeGreaterThan(node.py + node.h / 2);
    }
    const markup = ui.visualGroupMarkup(box);
    expect(markup).toContain('stroke="#123456"');
    expect(markup).toContain('fill="#abcdef"');
    expect(markup).toContain('fill-opacity="0"');
    expect(markup).toContain('fill="#654321"');
    expect(markup).toContain('pointer-events="none"');
    const editor = ui.visualVisible(graph, { ...viewState(), layout: 'editor' });
    expect(centres(editor)).toEqual([
      ['a', 150, 220],
      ['b', 350, 220],
    ]);
    const editorBox = ui.visualGroupBoxes(editor, graph.groups)[0];
    for (const node of editor.nodes) {
      expect(editorBox.x - editorBox.w / 2).toBeLessThan(node.px - node.w / 2);
      expect(editorBox.x + editorBox.w / 2).toBeGreaterThan(node.px + node.w / 2);
      expect(editorBox.y - editorBox.h / 2).toBeLessThan(node.py - node.h / 2);
      expect(editorBox.y + editorBox.h / 2).toBeGreaterThan(node.py + node.h / 2);
    }
  });

  it('discovers nested and removed groups and omits groups without visible members', () => {
    const ui = browserHelpers();
    const node = { id: 'a', type: 'function', x: 100, y: 100, wires: [] };
    const inner = { id: 'inner', type: 'group', nodes: ['a'] };
    const outer = { id: 'outer', type: 'group', nodes: ['inner'] };
    const empty = { id: 'empty', type: 'group', nodes: ['missing'] };
    const graph = ui.visualGraph(
      {
        baseFlow: { nodes: [node, inner] },
        visualLiveFlow: { nodes: [node, inner, outer, empty] },
        payload: { flow: { nodes: [node] } },
      },
      { modified: [{ id: 'a' }] }
    );
    const boxes = ui.visualGroupBoxes(ui.visualVisible(graph, viewState()), graph.groups);
    expect(boxes.map((box: any) => box.group.id).sort()).toEqual(['inner', 'outer']);
    expect(ui.visualGroupMarkup(boxes[0])).toContain('rx="4" ry="4"');
    expect(ui.visualGroupMarkup(boxes[0])).toContain('stroke="#a4a4a4"');
  });
});

describe('Visual View palette icons and editor sizing', () => {
  function graphNode(ui: any, raw: Record<string, unknown>) {
    return ui.visualGraph(
      { payload: { flow: { nodes: [{ id: 'n', type: 'function', ...raw }] } } },
      {}
    ).byId.n;
  }

  it.each([
    ['inject', 'inject.svg'],
    ['function', 'function.svg'],
    ['debug', 'debug.svg'],
    ['change', 'swap.svg'],
    ['switch', 'switch.svg'],
    ['http in', 'white-globe.svg'],
    ['http response', 'white-globe.svg'],
    ['link in', 'link-out.svg'],
    ['link out', 'link-out.svg'],
    ['catch', 'alert.svg'],
    ['comment', 'comment.svg'],
    ['complete', 'alert.svg'],
  ])(
    'upgrades %s from its fallback to a registered palette image on nodes and ghosts',
    (type, icon) => {
      const ui = browserHelpers();
      const raw = { type, x: 360, y: 200 };
      let n = graphNode(ui, raw);
      expect(ui.visualNodeSvg(n, {}, false)).toContain('visual-icon-fallback');
      expect(ui.visualNodeSvg(n, {}, false)).not.toContain('<image');
      ui.setTypeMetadata(type, { module: 'node-red', icon });
      n = graphNode(ui, raw);
      for (const ghost of [false, true]) {
        const html = ui.visualNodeSvg({ ...n, kind: 'moved', old: { x: 0, y: 0 } }, {}, ghost);
        expect(html).toContain('href="/icons/node-red/' + icon + '"');
        expect(html).toContain(
          'class="visual-icon-image" x="' +
            (type === 'debug' ? n.w - 30 : 0) +
            '" y="0" width="30" height="30"'
        );
      }
    }
  );

  it('resolves module-qualified, scoped, admin-root and legacy icon paths', () => {
    const ui = browserHelpers({}, [], undefined, undefined, { editorRoot: '/red/' });
    expect(ui.visualIconUrls({ icon: 'function.svg', module: 'node-red' })).toEqual([
      '/red/icons/node-red/function.svg',
    ]);
    expect(ui.visualIconUrls({ icon: '@example/nodes/custom.svg' })[0]).toBe(
      '/red/icons/%40example/nodes/custom.svg'
    );
    expect(ui.visualIconUrls({ icon: '/red/icons/node-red/function.svg' })[0]).toBe(
      '/red/icons/node-red/function.svg'
    );
    expect(ui.visualIconUrls({ icon: 'swap.png', module: 'contrib' })).toEqual([
      '/red/icons/contrib/swap.png',
      '/red/icons/contrib/swap.svg',
      '/red/icons/node-red/swap.png',
      '/red/icons/node-red/swap.svg',
    ]);
  });

  it.each([
    undefined,
    'font-awesome/fa-bolt',
    'fa fa-bolt',
    'https://example.com/icon.svg',
    '../icon.svg',
    '/unrelated/icon.svg',
  ])('keeps the typed fallback for unsupported icon %s', icon => {
    const ui = browserHelpers();
    ui.setTypeMetadata('custom', { icon, module: 'contrib' });
    const html = ui.visualNodeSvg(graphNode(ui, { type: 'custom' }), {}, false);
    expect(html).toContain('visual-icon-fallback');
    expect(html).not.toContain('<image');
  });

  it('replaces the fallback only after a successful image load and retains it on errors', () => {
    const ui = browserHelpers();
    const fallback = { setAttribute: vi.fn() };
    const attributes: Record<string, string> = {
      'data-icon-urls': JSON.stringify([
        '/icons/contrib/missing.svg',
        '/icons/node-red/missing.svg',
      ]),
      'data-icon-index': '0',
      visibility: 'hidden',
    };
    const image = {
      classList: { contains: (value: string) => value === 'visual-icon-image' },
      parentNode: { querySelector: () => fallback },
      getAttribute: (key: string) => attributes[key],
      setAttribute: (key: string, value: string) => {
        attributes[key] = String(value);
      },
      removeAttribute: (key: string) => {
        delete attributes[key];
      },
    };
    ui.visualIconEvent({ type: 'error', target: image });
    expect(attributes.href).toBe('/icons/node-red/missing.svg');
    ui.visualIconEvent({ type: 'error', target: image });
    expect(attributes.visibility).toBe('hidden');
    expect(fallback.setAttribute).not.toHaveBeenCalled();
    ui.visualIconEvent({ type: 'load', target: image });
    expect(fallback.setAttribute).toHaveBeenCalledWith('visibility', 'hidden');
    expect(attributes).not.toHaveProperty('visibility');
  });

  it('uses the registered alignment and vertically centres the icon for tall nodes', () => {
    const ui = browserHelpers();
    ui.setTypeMetadata('custom', {
      module: 'contrib',
      icon: 'custom.svg',
      align: 'right',
      outputs: 4,
    });
    const n = graphNode(ui, { type: 'custom' });
    const html = ui.visualNodeSvg(n, {}, false);
    expect(html).toContain(
      'class="visual-icon-image" x="' + (n.w - 30) + '" y="15" width="30" height="30"'
    );
    expect(html).toContain('text-anchor="end"');
    expect(html).not.toContain('width="32" height="26"');
  });

  it('uses both registered link-out icons according to the instance mode', () => {
    const ui = browserHelpers();
    ui.setTypeMetadata('link out', { module: 'node-red', icon: 'link-out.svg', align: 'right' });
    for (const mode of ['link', 'return']) {
      const n = graphNode(ui, { type: 'link out', mode });
      expect(ui.visualNodeSvg(n, {}, false)).toContain(
        '/icons/node-red/link-' + (mode === 'return' ? 'return' : 'out') + '.svg'
      );
    }
  });

  it.each([
    ['i', 0, 0, 100, 30],
    ['i', 1, 1, 100, 30],
    ['MMMM', 0, 1, 100, 30],
    ['MMMM', 1, 1, 120, 30],
    ['iiiiiiiiiiii', 1, 2, 100, 30],
    ['MMMMMMMMMMMM', 1, 4, 200, 60],
    ['Format payload', 1, 3, 160, 45],
    ['msg.payload', 1, 0, 140, 30],
  ])(
    'sizes %s with inputs=%s outputs=%s using editor advances and 20px snapping',
    (name, inputs, outputs, w, h) => {
      const ui = browserHelpers();
      const n = graphNode(ui, { name, inputs, outputs });
      expect(n).toMatchObject({ w, h });
      expect(n.w % 20).toBe(0);
    }
  );

  it('measures actual browser text at 14px Arial and refreshes sizing when ports arrive', () => {
    const canvas = { font: '', measureText: vi.fn(() => ({ width: 46.65 })) };
    const ui = browserHelpers({}, [], undefined, undefined, { canvas });
    let n = graphNode(ui, { type: 'custom', name: 'MMMM', inputs: 0 });
    expect(n).toMatchObject({ w: 100, h: 30 });
    expect(canvas.font).toBe('14px Arial');
    expect(canvas.measureText).toHaveBeenCalledWith('MMMM');
    ui.setTypeMetadata('custom', { inputs: 1, outputs: 4 });
    n = graphNode(ui, { type: 'custom', name: 'MMMM' });
    expect(n).toMatchObject({ w: 120, h: 60 });
  });

  it('keeps proportional advances and kerning without Canvas', () => {
    const ui = browserHelpers();
    expect(ui.visualTextWidth('MMMM')).toBeCloseTo(46.6484375);
    expect(ui.visualTextWidth('iiiiiiiiiiii')).toBeCloseTo(37.32421875);
    expect(ui.visualTextWidth('AVATAR')).toBeCloseTo(51.857421875);
    expect(ui.visualTextWidth('To')).toBeCloseTo(14.7861328125);
  });

  it.each([
    [{ type: 'debug', complete: 'true' }, 'msg'],
    [{ type: 'debug', complete: 'topic' }, 'msg.topic'],
    [{ type: 'debug', complete: true, console: true }, 'msg\t⇲'],
    [{ type: 'debug', complete: false }, 'msg.payload'],
    [{ type: 'debug', complete: 123 }, 'msg.123'],
    [{ type: 'debug', targetType: 'jsonata' }, 'JSONata'],
    [{ type: 'debug' }, 'msg.payload'],
    [{ type: 'inject', payloadType: 'date' }, 'timestamp'],
    [{ type: 'inject', name: 'Every 5s', repeat: '5' }, 'Every 5s\t↻'],
    [{ type: 'inject', name: 'Once', once: true }, 'Once ¹'],
    [{ type: 'inject', payload: 'hello', topic: 'greeting' }, 'greeting:hello'],
    [{ type: 'inject', payload: 123 }, '123'],
    [{ type: 'inject', payload: false }, 'false'],
    [{ type: 'inject', payloadType: 'flow', payload: 'count' }, 'flow.count'],
    [{ type: 'inject', payloadType: 'date', topic: 'tick' }, 'tick:timestamp'],
    [{ type: 'http response', statusCode: 201 }, 'http (201)'],
    [{ type: 'http in', url: 123 }, '[get] /123'],
    [{ type: 'http in', url: false }, '[get] /false'],
    [{ type: 'http in', url: 0 }, '[get] /0'],
    [{ type: 'http in', url: '' }, 'http'],
    [{ type: 'http in' }, 'http'],
    [{ type: 'http in', url: '/x', method: 'post' }, '[post] /x'],
    [{ type: 'function', name: 123 }, '123'],
    [{ type: 'function', label: true }, 'true'],
    [{ type: 'function', name: {}, label: 'Label' }, 'Label'],
    [{ type: 'change', rules: [{ t: 'set', pt: 'flow', p: 'count' }] }, 'set flow.count'],
    [{ type: 'change', action: 'move', property: 'topic' }, 'move msg.topic'],
    [{ type: 'change', rules: [{}, {}] }, 'change: 2 rules'],
    [{ type: 'change', rules: [{ t: '__proto__' }] }, 'change msg.payload'],
    [{ type: 'link in' }, 'link in'],
    [{ type: 'link out', mode: 'return' }, 'link return'],
    [{ type: 'catch', scope: 'group' }, 'catch: group'],
    [{ type: 'catch', scope: ['a', 'b'] }, 'catch: 2'],
    [{ type: 'catch', uncaught: true }, 'catch: uncaught'],
    [{ type: 'complete', scope: ['a'] }, 'complete: 1'],
  ])('sizes the editor label for %j', (raw, name) => {
    const ui = browserHelpers();
    const n = graphNode(ui, raw);
    expect(n.name).toBe(name);
    expect(n.w).toBe(
      Math.max(100, 20 * Math.ceil((ui.visualTextWidth(name) + 50 + (n.input ? 7 : 0)) / 20))
    );
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['name', { type: 'function' }, 'function'],
    ['label', { type: 'function' }, 'function'],
    ['complete', { type: 'debug' }, 'msg.payload'],
    ['targetType', { type: 'debug' }, 'msg.payload'],
    ['console', { type: 'debug' }, 'msg.payload'],
    ['statusCode', { type: 'http response' }, 'http'],
    ['url', { type: 'http in' }, 'http'],
    ['method', { type: 'http in', url: '/x' }, '[get] /x'],
    ['payload', { type: 'inject' }, 'inject'],
    ['topic', { type: 'inject', payload: 'hello' }, 'hello'],
    ['payloadType', { type: 'inject' }, 'inject'],
    ['topic', { type: 'inject', payloadType: 'date' }, 'timestamp'],
    ['payload', { type: 'inject', payloadType: 'flow' }, 'flow.'],
    ['repeat', { type: 'inject' }, 'inject'],
    ['crontab', { type: 'inject' }, 'inject'],
    ['once', { type: 'inject' }, 'inject'],
    ['rules', { type: 'change' }, 'change'],
    ['action', { type: 'change' }, 'delete msg.payload'],
    ['property', { type: 'change' }, 'delete msg.payload'],
    ['name', { type: 'link in' }, 'link in'],
    ['label', { type: 'link in' }, 'link in'],
    ['mode', { type: 'link out' }, 'link out'],
    ['name', { type: 'catch' }, 'catch: all'],
    ['scope', { type: 'catch' }, 'catch: all'],
    ['uncaught', { type: 'catch' }, 'catch: all'],
    ['name', { type: 'complete' }, 'complete: 0'],
    ['scope', { type: 'complete' }, 'complete: 0'],
  ])('falls back safely for non-primitive %s on %j', (field, raw, name) => {
    const ui = browserHelpers();
    const invalidValues = [
      { path: '/x' },
      { length: { count: 1 } },
      { length: 1, 0: { t: 'set', p: 'topic' } },
      Object.create(null),
      {
        toString() {
          throw new Error('Must not coerce objects');
        },
      },
      () => 'unexpected',
      Symbol('unexpected'),
      123n,
    ];
    // Scope arrays are valid node-id collections; every other field rejects arrays.
    if (field !== 'scope') invalidValues.push(['unexpected']);
    for (const value of invalidValues) {
      const n = graphNode(ui, { ...raw, [field]: value });
      expect(n.name).toBe(name);
      expect(n.name).not.toContain('[object Object]');
    }
  });

  it.each([null, undefined, false, 123, 'rule', [], [{}]])(
    'falls back safely for a malformed change rule %j',
    rule => {
      const n = graphNode(browserHelpers(), { type: 'change', rules: [rule] });
      expect(n.name).toBe('change');
    }
  );

  it.each(['t', 'pt', 'p'])('uses defaults for non-primitive change rule %s', field => {
    const ui = browserHelpers();
    for (const value of [{ unexpected: true }, ['unexpected'], Object.create(null)]) {
      const n = graphNode(ui, { type: 'change', rules: [{ [field]: value }] });
      expect(n.name).toBe('change msg.payload');
      expect(n.name).not.toContain('[object Object]');
    }
  });

  it('uses safe local labels when the live editor label throws', () => {
    const getNodeLabel = vi.fn(() => {
      throw new Error('Malformed editor node');
    });
    const red = { nodes: { getType: () => ({}) }, utils: { getNodeLabel } };
    const ui = browserHelpers({}, [], undefined, undefined, { red });
    expect(graphNode(ui, { type: 'http in', url: 123 }).name).toBe('[get] /123');
    expect(graphNode(ui, { type: 'debug', complete: {} }).name).toBe('msg.payload');
    expect(getNodeLabel).toHaveBeenCalledTimes(2);
  });

  it('reads live editor labels, icons and alignment when the registry is available', () => {
    const definition = { icon: 'palette.svg', align: 'right' };
    const getNodeLabel = vi.fn(() => 'Dynamic palette label');
    const getNodeIcon = vi.fn(() => '/icons/node-red/function.svg');
    const red = { nodes: { getType: () => definition }, utils: { getNodeLabel, getNodeIcon } };
    const ui = browserHelpers({}, [], undefined, undefined, { red });
    const n = graphNode(ui, { name: 'Custom', x: 0, y: 0 });
    expect(n).toMatchObject({
      name: 'Dynamic palette label',
      icon: '/icons/node-red/function.svg',
      align: 'right',
    });
    expect(getNodeLabel.mock.calls[0]![0]).toMatchObject({ name: 'Custom', _def: definition });
    expect(ui.visualNodeSvg(n, {}, false)).toContain('font-style="italic"');
  });

  it('preserves all editor centres, including zero and negative coordinates and move ghosts', () => {
    const ui = browserHelpers();
    const before = {
      nodes: [
        { id: 'a', type: 'function', x: 0, y: -30, name: 'MMMM', wires: [['b']] },
        { id: 'b', type: 'debug', x: -120, y: 0 },
      ],
    };
    const after = { nodes: [{ ...before.nodes[0], x: 340, y: 200 }, before.nodes[1]] };
    const graph = ui.visualGraph(
      { baseFlow: before, payload: { flow: after } },
      buildDiffSections(after, before)
    );
    const state = { ...viewState(), layout: 'editor', positions: { a: { x: 999, y: 999 } } };
    const visible = ui.visualVisible(graph, state);
    expect(centres(visible)).toEqual([
      ['b', -120, 0],
      ['a', 340, 200],
    ]);
    for (const n of visible.nodes) {
      expect(ui.visualNodeSvg(n, state, false)).toContain(
        'transform="translate(' + (n.raw.x - n.w / 2) + ',' + (n.raw.y - n.h / 2) + ')"'
      );
    }
    const a = graph.byId.a;
    expect(ui.visualNodeSvg(a, state, true)).toContain(
      'transform="translate(' + -a.w / 2 + ',' + (-30 - a.h / 2) + ')"'
    );
    const compact = ui.visualVisible(graph, viewState());
    const left = compact.byId.a,
      right = compact.byId.b;
    expect(right.px - right.w / 2 - (left.px + left.w / 2)).toBe(65);
  });
});

describe('Visual View live editor positions', () => {
  function rewire() {
    const baseFlow = {
      nodes: [
        {
          id: 'beta8_mcp_trial_inject',
          type: 'inject',
          name: 'Old inject',
          x: 170,
          y: 120,
          wires: [['beta8_mcp_trial_function']],
        },
        {
          id: 'beta8_mcp_trial_function',
          type: 'function',
          name: 'Old function',
          func: 'return msg;',
          x: 430,
          y: 120,
          wires: [['beta8_mcp_trial_debug']],
        },
        { id: 'beta8_mcp_trial_debug', type: 'debug', name: 'Old debug', x: 690, y: 120 },
        { id: 'df19c7e4b5bef165', type: 'comment', x: 320, y: 60 },
      ],
    };
    const flow = {
      nodes: [
        ...baseFlow.nodes.map(n =>
          n.type === 'function' ? { ...n, wires: [['visual14_rewire_debug']] } : { ...n }
        ),
        { id: 'visual14_rewire_debug', type: 'debug', x: 720, y: 210 },
      ],
    };
    const visualLiveFlow = {
      nodes: baseFlow.nodes.map(n => ({
        ...n,
        name: 'Live ' + n.type,
        x: n.type === 'function' ? 450 : n.type === 'debug' ? 760 : n.x,
        y: n.type === 'comment' ? 60 : 190,
      })),
    };
    return { baseFlow, visualLiveFlow, payload: { flow } };
  }

  it('draws the stale rewire in the live frame while retaining proposed wires and code', () => {
    const ui = browserHelpers(),
      p = rewire();
    const graph = ui.visualGraph(p, buildDiffSections(p.payload.flow, p.baseFlow));
    expect(centres(ui.visualVisible(graph, { ...viewState(), layout: 'editor' }))).toEqual([
      ['beta8_mcp_trial_inject', 170, 190],
      ['beta8_mcp_trial_function', 450, 190],
      ['visual14_rewire_debug', 740, 280],
      ['beta8_mcp_trial_debug', 760, 190],
    ]);
    expect(graph.byId.beta8_mcp_trial_function).toMatchObject({
      x: 450,
      y: 190,
      kind: 'modified',
      raw: { x: 430, y: 120, func: 'return msg;', wires: [['visual14_rewire_debug']] },
    });
    expect(graph.edges).toContainEqual({
      from: 'beta8_mcp_trial_function',
      to: 'visual14_rewire_debug',
      port: 0,
      kind: 'added',
    });
    expect(p.payload.flow.nodes.at(-1)).toMatchObject({ x: 720, y: 210 });
  });

  it.each(['modified', 'moved', 'conflict'])(
    'uses live coordinates for a deliberately moved %s node',
    kind => {
      const ui = browserHelpers();
      const original = { id: 'a', type: 'function', x: 10, y: 20, func: 'base' };
      const baseFlow = { nodes: [original] };
      const flow = {
        nodes: [
          { ...original, x: 900, y: 800, ...(kind === 'modified' ? { func: 'proposed' } : {}) },
        ],
      };
      const p = {
        baseFlow,
        visualLiveFlow: { nodes: [{ ...original, x: 0, y: -30, func: 'live' }] },
        payload: { flow },
        ...(kind === 'conflict' ? { conflictChoices: [{ nodeId: 'a', choice: 'proposed' }] } : {}),
      };
      const graph = ui.visualGraph(p, buildDiffSections(flow, baseFlow));
      expect(centres(ui.visualVisible(graph, { ...viewState(), layout: 'editor' }))).toEqual([
        ['a', 0, -30],
      ]);
      expect(graph.byId.a).toMatchObject({ kind, old: original, raw: flow.nodes[0], moved: true });
    }
  );

  it.each([false, true])(
    'chooses the nearest proposed wired neighbour with outgoing=%s',
    outgoing => {
      const ui = browserHelpers();
      const baseFlow = {
        nodes: [
          { id: 'a', type: 'function', x: 0, y: 0 },
          { id: 'b', type: 'function', x: 1000, y: 0 },
        ],
      };
      // Proposed centres make b closer; base centres would choose a.
      const flow = {
        nodes: [
          { ...baseFlow.nodes[0], x: 1500, wires: outgoing ? [] : [['new']] },
          { ...baseFlow.nodes[1], x: 110, wires: outgoing ? [] : [['new']] },
          { id: 'new', type: 'function', x: 100, y: 10, wires: outgoing ? [['a', 'b']] : [] },
        ],
      };
      const p = {
        baseFlow,
        payload: { flow },
        visualLiveFlow: {
          nodes: [
            { ...baseFlow.nodes[0], x: 20, y: 30 },
            { ...baseFlow.nodes[1], x: 1200, y: 90 },
          ],
        },
      };
      const graph = ui.visualGraph(p, buildDiffSections(flow, baseFlow));
      ui.visualVisible(graph, { ...viewState(), layout: 'editor' });
      expect(graph.byId.new).toMatchObject({ x: 300, y: 100, px: 300, py: 100 });
    }
  );

  it('falls back to base centres when a wired neighbour has no proposed centre', () => {
    const ui = browserHelpers();
    const baseFlow = { nodes: [{ id: 'a', type: 'function', x: 10, y: 20 }] };
    const flow = {
      nodes: [
        { id: 'a', type: 'function', wires: [['new']] },
        { id: 'new', type: 'debug', x: 100, y: 200 },
      ],
    };
    const p = {
      baseFlow,
      payload: { flow },
      visualLiveFlow: { nodes: [{ ...baseFlow.nodes[0], x: 40, y: 70 }] },
    };
    const graph = ui.visualGraph(p, buildDiffSections(flow, baseFlow));
    expect(centres(ui.visualVisible(graph, { ...viewState(), layout: 'editor' }))).toContainEqual([
      'new',
      130,
      250,
    ]);
  });

  it('uses independent flow medians for an addition without a wired neighbour', () => {
    const ui = browserHelpers();
    const baseFlow = {
      nodes: [
        { id: 'a', type: 'function', x: 10, y: 20 },
        { id: 'b', type: 'function', x: 30, y: 40 },
        { id: 'c', type: 'function', x: 50, y: 60 },
        { id: 'd', type: 'function', x: 70, y: 80 },
      ],
    };
    const flow = { nodes: [...baseFlow.nodes, { id: 'new', type: 'debug', x: 100, y: 200 }] };
    const p = {
      baseFlow,
      payload: { flow },
      visualLiveFlow: {
        nodes: [
          { ...baseFlow.nodes[0], x: 20, y: 120 },
          { ...baseFlow.nodes[1], x: 60, y: 60 },
          { ...baseFlow.nodes[2], x: 1050, y: 100 },
          { ...baseFlow.nodes[3], x: '90', y: NaN },
        ],
      },
    };
    const graph = ui.visualGraph(p, buildDiffSections(flow, baseFlow));
    expect(centres(ui.visualVisible(graph, { ...viewState(), layout: 'editor' }))).toEqual([
      ['new', 130, 240],
    ]);
  });

  it('uses live minus proposed medians when baseFlow is missing, before the live overlay', () => {
    const ui = browserHelpers();
    const flow = {
      nodes: [
        { id: 'a', type: 'function', x: 10, y: 20, wires: [['new']] },
        { id: 'b', type: 'function', x: 30, y: 40 },
        { id: 'new', type: 'debug', x: 100, y: 200 },
      ],
    };
    const visualLiveFlow = {
      nodes: [
        { ...flow.nodes[0], x: 30, y: 60 },
        { ...flow.nodes[1], x: 70, y: 120 },
      ],
    };
    const graph = ui.visualGraph({ payload: { flow }, visualLiveFlow }, { added: [flow.nodes[2]] });
    expect(centres(ui.visualVisible(graph, { ...viewState(), layout: 'editor' }))).toContainEqual([
      'new',
      130,
      260,
    ]);
  });

  it('checks live coordinates and neighbour offsets independently per axis', () => {
    const ui = browserHelpers();
    const baseFlow = {
      nodes: [
        { id: 'a', type: 'function', x: 10, y: 20 },
        { id: 'b', type: 'function', x: 30, y: 40 },
      ],
    };
    const flow = {
      nodes: [
        { ...baseFlow.nodes[0], x: 900, y: 800, wires: [['new']] },
        baseFlow.nodes[1],
        { id: 'new', type: 'debug', x: 100, y: 200 },
      ],
    };
    const p = {
      baseFlow,
      payload: { flow },
      visualLiveFlow: {
        nodes: [
          { ...baseFlow.nodes[0], x: 0, y: '70' },
          { ...baseFlow.nodes[1], x: Infinity, y: 100 },
        ],
      },
    };
    const graph = ui.visualGraph(p, buildDiffSections(flow, baseFlow));
    const visible = ui.visualVisible(graph, { ...viewState(), layout: 'editor' });
    expect(centres(visible)).toContainEqual(['a', 0, 800]);
    expect(centres(visible)).toContainEqual(['new', 90, 260]);
  });

  it('translates proposed nodes absent from live even when they also occur in base', () => {
    const ui = browserHelpers();
    const baseFlow = {
      nodes: [
        { id: 'a', type: 'function', x: 10, y: 20 },
        { id: 'restored', type: 'debug', x: 100, y: 200 },
      ],
    };
    const flow = {
      nodes: [
        { ...baseFlow.nodes[0], wires: [['restored']] },
        { ...baseFlow.nodes[1], name: 'Restored' },
      ],
    };
    const p = {
      baseFlow,
      payload: { flow },
      visualLiveFlow: { nodes: [{ ...baseFlow.nodes[0], x: 30, y: 60 }] },
    };
    const graph = ui.visualGraph(p, buildDiffSections(flow, baseFlow));
    expect(centres(ui.visualVisible(graph, { ...viewState(), layout: 'editor' }))).toContainEqual([
      'restored',
      120,
      240,
    ]);
  });

  it('keeps removed nodes at base positions and uses zero when no offset is available', () => {
    const ui = browserHelpers();
    const baseFlow = { nodes: [{ id: 'old', type: 'debug', x: -10, y: 0 }] };
    const flow = { nodes: [{ id: 'new', type: 'debug', x: 100, y: 200 }] };
    const graph = ui.visualGraph(
      { baseFlow, payload: { flow }, visualLiveFlow: { nodes: [] } },
      buildDiffSections(flow, baseFlow)
    );
    expect(centres(ui.visualVisible(graph, { ...viewState(), layout: 'editor' }))).toEqual([
      ['old', -10, 0],
      ['new', 100, 200],
    ]);
  });

  it('keeps raw proposal centres when visualLiveFlow is absent', () => {
    const ui = browserHelpers(),
      { visualLiveFlow: _live, ...p } = rewire();
    const graph = ui.visualGraph(p, buildDiffSections(p.payload.flow, p.baseFlow));
    expect(centres(ui.visualVisible(graph, { ...viewState(), layout: 'editor' }))).toEqual([
      ['beta8_mcp_trial_inject', 170, 120],
      ['beta8_mcp_trial_function', 430, 120],
      ['beta8_mcp_trial_debug', 690, 120],
      ['visual14_rewire_debug', 720, 210],
    ]);
  });

  it('keeps a loop and the corresponding acyclic chain on one compact row', () => {
    const ui = browserHelpers();
    const positions = [false, true].map(loop => {
      const nodes = [
        { id: 'kick', name: 'Kick off', type: 'inject', x: 100, y: 100, wires: [['work']] },
        { id: 'work', name: 'Do work', type: 'function', x: 250, y: 100, wires: [['switch']] },
        {
          id: 'switch',
          name: 'Need another pass?',
          type: 'switch',
          x: 400,
          y: 100,
          wires: [['finished'], loop ? ['work'] : []],
        },
        { id: 'finished', name: 'Finished', type: 'debug', x: 550, y: 100, wires: [] },
      ];
      const graph = ui.visualGraph({ payload: { flow: { nodes } } }, { added: nodes });
      const visible = ui.visualVisible(graph, viewState());
      return ['kick', 'work', 'switch', 'finished'].map(id => [
        visible.byId[id].px,
        visible.byId[id].py,
      ]);
    });
    expect(positions[1]).toEqual(positions[0]);
    expect(positions[1]!.map(position => position[1])).toEqual([110, 110, 110, 110]);
    for (let i = 1; i < positions[1]!.length; i++) {
      expect(positions[1]![i]![0]).toBeGreaterThan(positions[1]![i - 1]![0]);
    }
  });

  it('keeps a loop on one compact row when its sink is above the chain', () => {
    const ui = browserHelpers();
    const nodes = [
      { id: 'kick', name: 'Kick off', type: 'inject', x: 160, y: 200, wires: [['work']] },
      { id: 'work', name: 'Do work', type: 'function', x: 400, y: 200, wires: [['switch']] },
      {
        id: 'switch',
        name: 'Need another pass?',
        type: 'switch',
        x: 640,
        y: 200,
        wires: [['finished'], ['work']],
      },
      { id: 'finished', name: 'Finished', type: 'debug', x: 900, y: 140, wires: [] },
    ];
    const graph = ui.visualGraph({ payload: { flow: { nodes } } }, { added: nodes });
    const visible = ui.visualVisible(graph, viewState());
    const positions = ['kick', 'work', 'switch', 'finished'].map(id => visible.byId[id]);
    expect(positions.map(node => node.py)).toEqual([110, 110, 110, 110]);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i].px).toBeGreaterThan(positions[i - 1].px);
    }
  });

  it('stacks disjoint chains in live vertical order without sharing rows', () => {
    const ui = browserHelpers();
    const nodes = [300, 100, 200].flatMap((y, chain) =>
      Array.from({ length: 3 }, (_, i) => ({
        id: `${chain}-${i}`,
        type: 'function',
        x: 100 + i * 150,
        y,
        wires: i < 2 ? [[`${chain}-${i + 1}`]] : [],
      }))
    );
    const flow = { nodes };
    const graph = ui.visualGraph({ payload: { flow } }, { added: nodes });
    const visible = ui.visualVisible(graph, viewState());
    const rows = [0, 1, 2].map(chain => [0, 1, 2].map(i => visible.byId[`${chain}-${i}`].py));
    expect(rows).toEqual([
      [280, 280, 280],
      [110, 110, 110],
      [195, 195, 195],
    ]);
    expect(new Set(rows.map(row => row[0])).size).toBe(3);
  });

  it('keeps linked link out and link in chains in separate compact bands', () => {
    const ui = browserHelpers();
    const nodes = [
      { id: 'inject', type: 'inject', x: 100, y: 100, wires: [['before']] },
      { id: 'before', type: 'function', x: 250, y: 100, wires: [['out']] },
      { id: 'out', type: 'link out', x: 400, y: 100, wires: [], links: ['in'] },
      { id: 'in', type: 'link in', x: 100, y: 200, wires: [['after']], links: ['out'] },
      { id: 'after', type: 'function', x: 250, y: 200, wires: [['debug']] },
      { id: 'debug', type: 'debug', x: 400, y: 200, wires: [] },
    ];
    const graph = ui.visualGraph({ payload: { flow: { nodes } } }, { added: nodes });
    const visible = ui.visualVisible(graph, viewState());
    for (const edges of [graph.edges, visible.edges]) {
      expect(edges).not.toContainEqual(expect.objectContaining({ from: 'out', to: 'in' }));
    }
    const firstRows = ['inject', 'before', 'out'].map(id => visible.byId[id].py);
    const secondRows = ['in', 'after', 'debug'].map(id => visible.byId[id].py);
    expect(new Set(firstRows).size).toBe(1);
    expect(new Set(secondRows).size).toBe(1);
    expect(firstRows.every(row => !secondRows.includes(row))).toBe(true);
  });

  it('keeps the VR trigger, marker and debug together on their own row', () => {
    const ui = browserHelpers();
    const nodes = [
      { id: 'vr1', name: 'VR · manual trigger', x: 100, y: 200, wires: [['vr2']] },
      { id: 'vr2', name: 'VR · set marker', x: 250, y: 200, wires: [['vr3']] },
      { id: 'vr3', name: 'VR · debug output', x: 400, y: 200, wires: [] },
      { id: 'other1', name: 'Other', x: 100, y: 100, wires: [['other2']] },
      { id: 'other2', name: 'Other debug', x: 400, y: 100, wires: [] },
    ].map(n => ({ ...n, type: 'function' }));
    const graph = ui.visualGraph({ payload: { flow: { nodes } } }, { added: nodes });
    const visible = ui.visualVisible(graph, viewState());
    const row = visible.byId.vr1.py;
    expect(visible.byId.vr2.py).toBe(row);
    expect(visible.byId.vr3.py).toBe(row);
    expect(
      visible.nodes
        .filter((n: any) => n.py === row)
        .map((n: any) => n.id)
        .sort()
    ).toEqual(['vr1', 'vr2', 'vr3']);
  });

  it('keeps merging HTTP branches in one band with the continuation on the spine', () => {
    const ui = browserHelpers();
    const nodes = [
      ...[100, 160, 220].flatMap((y, i) => [
        { id: `source${i}`, x: 100, y, wires: [[`branch${i}`]] },
        { id: `branch${i}`, x: 250, y, wires: [['builder']] },
      ]),
      {
        id: 'builder',
        name: 'HTTP · shared response builder',
        x: 400,
        y: 100,
        wires: [['response']],
      },
      { id: 'response', name: 'HTTP · response (HTML)', x: 550, y: 100, wires: [] },
      { id: 'next', x: 100, y: 400, wires: [] },
    ].map(n => ({ ...n, type: 'function' }));
    const graph = ui.visualGraph({ payload: { flow: { nodes } } }, { added: nodes });
    const visible = ui.visualVisible(graph, viewState());
    const rows = [0, 1, 2].map(i => visible.byId[`source${i}`].py);
    expect(rows).toEqual([110, 195, 280]);
    rows.forEach((row, i) => expect(visible.byId[`branch${i}`].py).toBe(row));
    expect(visible.byId.builder.py).toBe((rows[0]! + rows[2]!) / 2);
    expect(visible.byId.response.py).toBe(visible.byId.builder.py);
    const componentRows = nodes.filter(n => n.id !== 'next').map(n => visible.byId[n.id].py);
    expect(Math.max(...componentRows)).toBeLessThan(visible.byId.next.py);
    expect(visible.nodes.filter((n: any) => n.py < visible.byId.next.py)).toHaveLength(8);
  });

  it.each([2, 3, 5])('centres a %i-to-one merge and its continuation', count => {
    const ui = browserHelpers();
    const nodes = [
      ...Array.from({ length: count }, (_, i) => [
        { id: `source${i}`, x: 100, y: 100 + i * 60, wires: [[`branch${i}`]] },
        { id: `branch${i}`, x: 250, y: 100 + i * 60, wires: [['merge']] },
      ]).flat(),
      { id: 'merge', x: 400, y: 100, wires: [['end']] },
      { id: 'end', x: 550, y: 100, wires: [] },
    ].map(n => ({ ...n, type: 'function' }));
    const graph = ui.visualGraph({ payload: { flow: { nodes } } }, { added: nodes });
    const visible = ui.visualVisible(graph, viewState());
    const rows = Array.from({ length: count }, (_, i) => 110 + i * 85);
    rows.forEach((y, i) => {
      expect(visible.byId[`source${i}`].py).toBe(y);
      expect(visible.byId[`branch${i}`].py).toBe(y);
    });
    expect(visible.byId.merge.py).toBe((rows[0]! + rows[count - 1]!) / 2);
    expect(visible.byId.end.py).toBe(visible.byId.merge.py);
  });

  it('centres a fan-out and its upstream in port order', () => {
    const ui = browserHelpers();
    const nodes = [
      { id: 'up', x: 100, y: 100, wires: [['split']] },
      { id: 'split', x: 250, y: 100, wires: [['a'], ['b'], ['c']] },
      { id: 'a', x: 400, y: 300, wires: [] },
      { id: 'b', x: 400, y: 100, wires: [] },
      { id: 'c', x: 400, y: 200, wires: [] },
    ].map(n => ({ ...n, type: 'function' }));
    const graph = ui.visualGraph({ payload: { flow: { nodes } } }, { added: nodes });
    const visible = ui.visualVisible(graph, viewState());
    expect(['a', 'b', 'c'].map(id => visible.byId[id].py)).toEqual([110, 195, 280]);
    expect(visible.byId.split.py).toBe(195);
    expect(visible.byId.up.py).toBe(195);
  });

  it('centres both ends of a diamond between its sides', () => {
    const ui = browserHelpers();
    const nodes = [
      { id: 'split', x: 100, y: 100, wires: [['a', 'b']] },
      { id: 'a', x: 250, y: 100, wires: [['sink']] },
      { id: 'b', x: 250, y: 200, wires: [['sink']] },
      { id: 'sink', x: 400, y: 100, wires: [] },
    ].map(n => ({ ...n, type: 'function' }));
    const graph = ui.visualGraph({ payload: { flow: { nodes } } }, { added: nodes });
    const visible = ui.visualVisible(graph, viewState());
    expect([visible.byId.a.py, visible.byId.b.py]).toEqual([110, 195]);
    expect(visible.byId.split.py).toBe(152.5);
    expect(visible.byId.sink.py).toBe(152.5);
  });

  it('keeps a nested diamond in a contiguous centred outer branch', () => {
    const ui = browserHelpers();
    const nodes = [
      { id: 'outer', x: 100, y: 100, wires: [['inner', 'other']] },
      { id: 'inner', x: 250, y: 100, wires: [['a', 'b']] },
      { id: 'other', x: 250, y: 300, wires: [['end']] },
      { id: 'a', x: 400, y: 100, wires: [['join']] },
      { id: 'b', x: 400, y: 200, wires: [['join']] },
      { id: 'join', x: 550, y: 100, wires: [['end']] },
      { id: 'end', x: 700, y: 100, wires: [] },
    ].map(n => ({ ...n, type: 'function' }));
    const graph = ui.visualGraph({ payload: { flow: { nodes } } }, { added: nodes });
    const visible = ui.visualVisible(graph, viewState());
    const y = (id: string) => visible.byId[id].py;
    expect([y('a'), y('b'), y('other')]).toEqual([110, 195, 280]);
    expect(y('inner')).toBe((y('a') + y('b')) / 2);
    expect(y('join')).toBe(y('inner'));
    expect(y('outer')).toBe((y('a') + y('other')) / 2);
    expect(y('end')).toBe(y('outer'));
    for (const a of visible.nodes)
      for (const b of visible.nodes) {
        if (a.id !== b.id && a.px === b.px)
          expect(Math.abs(a.py - b.py)).toBeGreaterThanOrEqual(85);
      }
  });

  it('keeps compact ranks and lanes even when translation changes the editor ordering', () => {
    const ui = browserHelpers(),
      p = rewire();
    // Translation moves the addition past the original debug in editor mode.
    p.visualLiveFlow.nodes[1]!.x = 630;
    const graph = ui.visualGraph(p, buildDiffSections(p.payload.flow, p.baseFlow));
    const editor = centres(ui.visualVisible(graph, { ...viewState(), layout: 'editor' }));
    expect(editor).toContainEqual(['visual14_rewire_debug', 920, 280]);
    const compact = ui.visualVisible(graph, viewState());
    expect(compact.byId.beta8_mcp_trial_inject.px).toBe(80);
    const debugRows = [
      compact.byId.beta8_mcp_trial_debug.py,
      compact.byId.visual14_rewire_debug.py,
    ];
    expect(debugRows[0]).toBeLessThan(debugRows[1]);
    expect(Math.abs(debugRows[0] - debugRows[1])).toBeGreaterThanOrEqual(85);
    expect(compact.byId.beta8_mcp_trial_inject.py).toBe((debugRows[0] + debugRows[1]) / 2);
    expect(compact.byId.beta8_mcp_trial_function.py).toBe(compact.byId.beta8_mcp_trial_inject.py);
    expect(compact.byId.visual14_rewire_debug.px).toBe(compact.byId.beta8_mcp_trial_debug.px);
    expect(compact.byId.beta8_mcp_trial_function.px).toBeGreaterThan(
      compact.byId.beta8_mcp_trial_inject.px
    );
    expect(compact.byId.visual14_rewire_debug.px).toBeGreaterThan(
      compact.byId.beta8_mcp_trial_function.px
    );
    expect(centres(compact)).not.toEqual(editor);
  });

  it('puts the original rewire target above a new target with a smaller proposed y', () => {
    const ui = browserHelpers(),
      p = rewire();
    p.payload.flow.nodes.find(n => n.id === 'visual14_rewire_debug')!.y = 20;
    const graph = ui.visualGraph(p, buildDiffSections(p.payload.flow, p.baseFlow));
    const compact = ui.visualVisible(graph, viewState());
    const original = compact.byId.beta8_mcp_trial_debug;
    const added = compact.byId.visual14_rewire_debug;
    expect(original.py).toBeLessThan(added.py);
    expect(compact.byId.beta8_mcp_trial_function.py).toBe((original.py + added.py) / 2);
  });
});

describe('Visual View fit geometry', () => {
  const fit = runInNewContext(pageClientVisualGeometryScript() + '\nvisualFitView;');

  it('fits a tall flow by width, centered horizontally and aligned to its padded top', () => {
    const boxes = [
      { x: 100, y: 100, w: 100, h: 40 },
      { x: 800, y: 1580, w: 100, h: 40 },
    ];
    const w = 900,
      h = 420;
    const minX = 15,
      maxX = 885,
      minY = 72,
      maxY = 1608;
    const view = fit(boxes, w, h);
    expect(view.k).toBeCloseTo(Math.min(1.2, (w - 24) / (maxX - minX)));
    expect(view.k).toBeGreaterThan(
      Math.min(1.2, (w - 24) / (maxX - minX), (h - 65) / (maxY - minY))
    );
    expect(view.x).toBeCloseTo(w / 2 - ((minX + maxX) / 2) * view.k);
    expect(view.y + minY * view.k).toBeCloseTo(48);
    expect(view.y).not.toBeCloseTo((h - 30) / 2 - ((minY + maxY) / 2) * view.k);
  });

  it('centres a short narrow flow and caps zoom', () => {
    const view = fit([{ x: 200, y: 100, w: 100, h: 40 }], 900, 420);
    expect(view.k).toBe(1.2);
    expect(view.x).toBeCloseTo(900 / 2 - 200 * 1.2);
    expect(view.y + 100 * view.k).toBeCloseTo(420 / 2);
  });

  it('clamps a nearly fitting flow below the toggle', () => {
    const view = fit([{ x: 200, y: 200, w: 100, h: 274 }], 900, 420);
    const minY = 200 - 274 / 2 - 8;
    expect((420 - (274 + 16) * view.k) / 2).toBeLessThan(48);
    expect(view.y + minY * view.k).toBeCloseTo(48);
    const custom = fit([{ x: 200, y: 200, w: 100, h: 274 }], 900, 420, 60);
    expect(custom.y + minY * custom.k).toBeCloseTo(60);
  });

  it('fits a tall flow to mobile width and still caps zoom for narrow content', () => {
    const boxes = [{ x: 150, y: 100, w: 300, h: 1500 }];
    const view = fit(boxes, 350, 600);
    expect(view.k).toBeCloseTo((350 - 24) / 370);
    expect(view.x).toBeCloseTo(350 / 2 - 150 * view.k);
    expect(view.y + (100 - 750 - 8) * view.k).toBeCloseTo(48);
    expect(fit([{ x: 0, y: 0, w: 100, h: 1500 }], 350, 600).k).toBe(1.2);
  });
});

describe('Node-RED link geometry', () => {
  const geometry = runInNewContext(
    pageClientVisualGeometryScript() + '\n({ visualLinkPath, visualLinkPathMidpoint });'
  );
  const reference = runInNewContext(
    'var lineCurveScale = 0.75, node_width = 100, node_height = 30;\n' +
      readFileSync('test/plugin/fixtures/nr4-generate-link-path.txt', 'utf8') +
      '\ngenerateLinkPath;'
  );

  it.each([
    [100, 120, 400, 180, 1, false],
    [100, 120, 130, 135, 1, false],
    [520, 190, 260, 194, 1, false],
    [520, 190, 260, 194, 1, true],
    [520, 190, 260, 80, 1, false],
    [520, 80, 260, 190, 1, true],
    [520, 190, 690, 80, 1, false],
  ])('matches the editor path for %s,%s to %s,%s', (...args) => {
    expect(geometry.visualLinkPath(...args)).toBe(reference(...args));
  });

  it('finds the midpoint by path length on forward and shallow loop paths', () => {
    const forward = geometry.visualLinkPath(0, 0, 200, 0, 1, false);
    const loop = geometry.visualLinkPath(200, 0, 0, 0, 1, false);
    expect(geometry.visualLinkPathMidpoint(forward).x).toBeCloseTo(100, 3);
    expect(geometry.visualLinkPathMidpoint(loop).x).toBeCloseTo(100, 3);
    expect(geometry.visualLinkPathMidpoint(loop).y).toBeCloseTo(25, 3);
  });
});

describe('Visual View geometry', () => {
  const moveGeometry = runInNewContext(pageClientVisualGeometryScript() + '\nvisualMoveGeometry;');

  it.each([
    { next: { x: 200, y: 120 }, end: { x: 166.66666666666669, y: 100 } },
    { next: { x: 400, y: 0 }, end: { x: 345, y: 0 } },
    { next: { x: 0, y: 60 }, end: { x: 0, y: 40 } },
    { next: { x: -200, y: -120 }, end: { x: -166.66666666666669, y: -100 } },
    { next: { x: -400, y: 0 }, end: { x: -345, y: 0 } },
    { next: { x: 0, y: -60 }, end: { x: 0, y: -40 } },
  ])(
    'starts at the ghost centre and clips the landing to the new outline edge: $next',
    ({ next, end }) => {
      const old = { x: 0, y: 0 };
      const arrow = moveGeometry(old, next, 100, 30);
      expect(arrow.start).toEqual(old);
      expect(arrow.end).toEqual(end);
      for (const [point, centre] of [[arrow.end, next]]) {
        const dx = Math.abs(point.x - centre.x),
          dy = Math.abs(point.y - centre.y);
        expect(dx).toBeLessThanOrEqual(55);
        expect(dy).toBeLessThanOrEqual(20);
        expect(dx === 55 || dy === 20).toBe(true);
        expect((point.x - centre.x) * next.y - (point.y - centre.y) * next.x).toBeCloseTo(0);
      }
      expect(arrow.gap).toBeCloseTo(
        Math.hypot(end.x, end.y) -
          Math.hypot(next.x, next.y) *
            Math.min(
              next.x ? 50 / Math.abs(next.x) : Infinity,
              next.y ? 15 / Math.abs(next.y) : Infinity
            )
      );
      expect(Math.hypot(end.x - arrow.shaftEnd.x, end.y - arrow.shaftEnd.y)).toBeCloseTo(12);
      expect(arrow.shaftEnd.x).toBeCloseTo(end.x - (next.x / Math.hypot(next.x, next.y)) * 12);
      expect(arrow.shaftEnd.y).toBeCloseTo(end.y - (next.y / Math.hypot(next.x, next.y)) * 12);
      expect((arrow.headLeft.x + arrow.headRight.x) / 2).toBeCloseTo(arrow.shaftEnd.x);
      expect((arrow.headLeft.y + arrow.headRight.y) / 2).toBeCloseTo(arrow.shaftEnd.y);
      expect(
        Math.hypot(arrow.headLeft.x - arrow.headRight.x, arrow.headLeft.y - arrow.headRight.y)
      ).toBeCloseTo(12);
    }
  );

  it.each([
    { x: 0, y: 0 },
    { x: 90, y: 20 },
    { x: 100, y: 30 },
    { x: 105, y: 35 },
    { x: -105, y: 0 },
  ])('hides overlapping or touching moves: %j', next => {
    expect(moveGeometry({ x: 0, y: 0 }, next, 100, 30)).toBeNull();
  });

  it('derives selected and unselected landings from their crisp outline strokes', () => {
    const pad = runInNewContext(pageClientVisualGeometryScript() + '\nvisualMoveOutlinePad;');
    expect(pad(false)).toBe(5);
    expect(pad(true)).toBe(5.875);
    const ends = [false, true].map(selected => {
      const arrow = moveGeometry({ x: 0, y: 0 }, { x: 400, y: 0 }, 100, 30, pad(selected));
      expect(400 - arrow.end.x).toBe(50 + pad(selected));
      return arrow.end.x;
    });
    expect(ends).toEqual([345, 344.125]);
    expect(moveGeometry({ x: 0, y: 0 }, { x: 105.875, y: 0 }, 100, 30, pad(true))).toBeNull();
  });

  it.each([5, 5.875])('shows the +120,+40 move on the expanded outline with pad %s', pad => {
    const arrow = moveGeometry({ x: 0, y: 0 }, { x: 120, y: 40 }, 100, 30, pad);
    expect(arrow).not.toBeNull();
    expect(arrow.start).toEqual({ x: 0, y: 0 });
    expect(arrow.end.x).toBeCloseTo(120 - (50 + pad));
    expect(arrow.end.y).toBeCloseTo(40 - (50 + pad) / 3);
    const wideArrow = moveGeometry({ x: 0, y: 0 }, { x: 120, y: 40 }, 160, 30, pad);
    expect(wideArrow.end.x).toBeCloseTo(120 - 3 * (15 + pad));
    expect(wideArrow.end.y).toBeCloseTo(40 - (15 + pad));
    expect(wideArrow.gap).toBeLessThan(16);
  });

  it('shows small body-to-outline gaps when the centre-to-outline shaft fits the tip', () => {
    expect(moveGeometry({ x: 0, y: 0 }, { x: 106, y: 0 }, 100, 30).gap).toBeCloseTo(1);
    expect(moveGeometry({ x: 0, y: 0 }, { x: 0, y: 36 }, 100, 30).gap).toBeCloseTo(1);
  });

  it('requires enough centre-to-outline length for the 12px tip', () => {
    expect(moveGeometry({ x: 0, y: 0 }, { x: 17.9, y: 0 }, 2, 2)).toBeNull();
    const arrow = moveGeometry({ x: 0, y: 0 }, { x: 18, y: 0 }, 2, 2);
    expect(arrow.end).toEqual({ x: 12, y: 0 });
    expect(arrow.shaftEnd).toEqual({ x: 0, y: 0 });
  });

  it.each([3, 4, 5, 6])(
    'anchors an odd centre or even group midpoint for %i nodes with unequal widths',
    length => {
      const context = {};
      runInNewContext(pageClientVisualGeometryScript(), context);
      const widths = Array.from({ length }, (_, i) => 100 + i * 20);
      const positions = runInNewContext(
        `visualRunGeometry(${JSON.stringify(widths)}, 431, 'middle', 65)`,
        context
      );
      const anchor =
        length % 2
          ? positions[(length - 1) / 2]
          : (positions[0] - widths[0]! / 2 + positions[length - 1] + widths[length - 1]! / 2) / 2;
      expect(anchor).toBe(431);
    }
  );

  it.each([
    { edits: [8], mode: 'leading' },
    { edits: [0], mode: 'trailing' },
    { edits: [0, 8], mode: 'middle' },
    { edits: [0, 7], mode: 'middle' },
  ])('expands $mode at the old pill screen position and collapses exactly', ({ edits, mode }) => {
    const ui = browserHelpers(),
      { p, diff } = chain(edits, edits.includes(7) ? 8 : 9);
    const graph = ui.visualGraph(p, diff),
      state = viewState();
    const visible = ui.visualVisible(graph, state),
      original = centres(visible);
    const run = graph.runs[0],
      pill = visible.byId[run.id];
    const anchor = { x: pill.px, y: pill.py },
      view = { ...state.view };
    ui.visualToggleRun(graph, state, visible, run.id);
    const expanded = ui.visualVisible(graph, state);
    const nodes = run.ids.map((id: string) => expanded.byId[id]);
    const fixed =
      mode === 'leading'
        ? nodes.at(-1).px
        : mode === 'trailing'
          ? nodes[0].px
          : nodes.length % 2
            ? nodes[(nodes.length - 1) / 2].px
            : (nodes[0].px - nodes[0].w / 2 + nodes.at(-1).px + nodes.at(-1).w / 2) / 2;
    expect(fixed * state.view.k + state.view.x).toBe(anchor.x * view.k + view.x);
    expect(state.view).toEqual(view);
    expect(state.anchors[run.id].x).toBe(anchor.x);
    if (mode === 'middle') {
      const beforeLeft = original.find((n: any) => n[0] === 'n0')![1];
      const beforeRight = original.find(
        (n: any) => n[0] === 'n' + (p.payload.flow.nodes.length - 1)
      )![1];
      expect(beforeLeft - expanded.byId.n0.px).toBe(
        expanded.byId['n' + (p.payload.flow.nodes.length - 1)].px - beforeRight
      );
    }
    ui.visualToggleRun(graph, state, expanded, run.id);
    expect(centres(ui.visualVisible(graph, state))).toEqual(original);
    expect(state.view).toEqual(view);
    // Repeat expansion after pan and zoom, preserving the same fixed point.
    state.view = { x: -200, y: 80, k: 1.7 };
    ui.visualToggleRun(graph, state, ui.visualVisible(graph, state), run.id);
    ui.visualToggleRun(graph, state, ui.visualVisible(graph, state), run.id);
    expect(centres(ui.visualVisible(graph, state))).toEqual(original);
    expect(state.view).toEqual({ x: -200, y: 80, k: 1.7 });
  });

  it.each([false, true])(
    'round trips multiple middle runs, including collapse out of order (%s)',
    reverse => {
      const ui = browserHelpers(),
        { p, diff } = chain([0, 4, 8]);
      const graph = ui.visualGraph(p, diff),
        state = viewState();
      const original = centres(ui.visualVisible(graph, state));
      graph.runs.forEach((run: any) =>
        ui.visualToggleRun(graph, state, ui.visualVisible(graph, state), run.id)
      );
      const order = reverse ? [...graph.runs].reverse() : graph.runs;
      order.forEach((run: any) =>
        ui.visualToggleRun(graph, state, ui.visualVisible(graph, state), run.id)
      );
      expect(centres(ui.visualVisible(graph, state))).toEqual(original);
    }
  );

  it('treats movement over four pixels as a drag', () => {
    const context = {};
    runInNewContext(pageClientVisualGeometryScript(), context);
    expect(runInNewContext('visualPointerMoved({x:0,y:0}, {x:4,y:0})', context)).toBe(false);
    expect(runInNewContext('visualPointerMoved({x:0,y:0}, {x:3,y:3})', context)).toBe(true);
  });

  it.each([
    'inject',
    'link in',
    'catch',
    'status',
    'complete',
    'http in',
    'mqtt in',
    'comment',
    'debug',
    'link out',
    'http response',
  ])('resolves %s ports for changed, ghost, and context nodes before and after metadata', type => {
    const ui = browserHelpers();
    const inputs = ['debug', 'link out', 'http response'].includes(type) ? 1 : 0;
    const outputs = ['debug', 'link out', 'http response', 'comment'].includes(type) ? 0 : 1;
    const p = { payload: { flow: { nodes: [{ id: 'n', type, wires: [[]] }] } } };
    for (const meta of [{}, { inputs, outputs }]) {
      ui.setTypeMetadata(type, meta);
      const n = ui.visualGraph(p, {}).byId.n;
      expect(n.input).toBe(inputs > 0);
      expect(n.outputs).toBe(outputs);
      for (const kind of ['modified', '']) {
        for (const ghost of [false, true]) {
          const svg = ui.visualNodeSvg({ ...n, kind, old: { x: 100, y: 100 } }, {}, ghost);
          expect(svg.includes('<rect x="-5"')).toBe(inputs > 0);
          expect(svg.match(/width="10" height="10" rx="3"/g) ?? []).toHaveLength(inputs + outputs);
        }
      }
    }
  });

  it('prefers finite instance counts, then metadata, then unknown-type fallbacks', () => {
    const ui = browserHelpers();
    ui.setTypeMetadata('function', { inputs: 0, outputs: 0 });
    const graph = (raw: Record<string, unknown>) =>
      ui.visualGraph({ payload: { flow: { nodes: [{ id: 'n', ...raw }] } } }, {}).byId.n;
    expect(graph({ type: 'function', inputs: 1, outputs: 3 })).toMatchObject({
      input: true,
      outputs: 3,
    });
    expect(
      graph({ type: 'function', inputs: NaN, outputs: Infinity, wires: [[], []] })
    ).toMatchObject({ input: false, outputs: 0 });
    expect(graph({ type: 'unknown' })).toMatchObject({ input: true, outputs: 1 });
    expect(graph({ type: 'unknown', wires: [[], []] })).toMatchObject({ input: true, outputs: 2 });
  });

  it.each([200000, 1, 2, -1, NaN, Infinity, -Infinity])(
    'bounds rendered outputs for %s',
    outputs => {
      const ui = browserHelpers();
      const p = { payload: { flow: { nodes: [{ id: 'n', type: 'inject', outputs }] } } };
      const n = ui.visualGraph(p, {}).byId.n;
      const visible = Number.isFinite(outputs) ? Math.max(0, Math.min(32, outputs)) : 1;
      expect(n.outputs).toBe(visible);
      expect(n.h).toBe(Math.max(30, visible * 15));
      const html = ui.visualNodeSvg(n, {}, false);
      expect(html.length).toBeLessThan(10000);
      expect(html.match(/width="10" height="10" rx="3"/g) ?? []).toHaveLength(visible);
      if (outputs > 32 && Number.isFinite(outputs)) expect(html).toContain('+199968</text>');
      else expect(html).not.toMatch(/>\+\d+<\/text>/);
    }
  );

  it('lets plain wheel events scroll and zooms only with Ctrl or Meta', () => {
    const script = pageClientScript();
    const handler = script.slice(
      script.indexOf("    svg.addEventListener('wheel'"),
      script.indexOf('    host.onclick =')
    );
    let wheel: (ev: any) => void = vi.fn();
    const zoom = vi.fn(),
      preventDefault = vi.fn();
    runInNewContext(handler, {
      svg: {
        addEventListener: (_event: string, fn: typeof wheel) => {
          wheel = fn;
        },
        getBoundingClientRect: () => ({ left: 10, top: 20 }),
      },
      zoom,
    });
    wheel({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(zoom).not.toHaveBeenCalled();
    for (const modifier of ['ctrlKey', 'metaKey'])
      wheel({ [modifier]: true, deltaY: -100, clientX: 50, clientY: 60, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(zoom).toHaveBeenCalledTimes(2);
    expect(zoom).toHaveBeenLastCalledWith(Math.exp(0.1), 40, 40);
  });

  it('renders a moved ghost with real node appearance, solid ports and no interaction or change decorations', () => {
    const ui = browserHelpers(),
      { p, diff } = chain([4]);
    p.payload.flow.nodes[4]!.x += 250;
    const graph = ui.visualGraph(p, diff),
      n = graph.byId.n4;
    const html = ui.visualNodeSvg(n, { selected: n.id }, true);
    expect(html).toContain('move-ghost');
    expect(html).toContain('pointer-events="none"');
    expect(html).toContain('stroke-dasharray="8,3" fill-opacity=".6"');
    expect(html).toContain('rx="5"');
    expect(html).toContain('fill-opacity="1" stroke-dasharray="none"');
    expect(html).not.toMatch(
      /data-visual-node|tabindex|role="button"|change-outline|selection-glow|filter=|font-style="italic"/
    );
  });

  it.each(['debug', 'inject'])('styles both %s button rectangles for every ghost kind', type => {
    const ui = browserHelpers(),
      { p, diff } = chain([4]);
    const n = { ...ui.visualGraph(p, diff).byId.n4, type };
    for (const kind of ['moved', 'removed', 'modified', 'conflict', 'added', '']) {
      for (const ghost of [true, false]) {
        const html = ui.visualNodeSvg({ ...n, kind }, {}, ghost);
        const buttons = html.match(/<rect[^>]*width="(?:32|16)"[^>]*\/>/g);
        expect(buttons).toHaveLength(2);
        for (const rect of buttons!) {
          if (ghost) {
            expect(rect).toContain('stroke-dasharray="8,3"');
            expect(rect).toContain('fill-opacity=".6"');
          } else {
            expect(rect).not.toMatch(/stroke-dasharray|fill-opacity/);
          }
        }
      }
    }
  });

  it.each([
    { coarse: false, width: 1200, hint: 'Drag to pan · Ctrl / ⌘ + scroll to zoom' },
    { coarse: true, width: 1200, hint: 'Drag to pan' },
    { coarse: false, width: 600, hint: 'Drag to pan' },
  ])('uses an appropriate pan hint at $width px with coarse=$coarse', ({ coarse, width, hint }) => {
    const matchMedia = vi.fn(() => ({ matches: coarse || width <= 760 }));
    const ui = browserHelpers({}, [], matchMedia),
      { p, diff } = chain([4]);
    const html = ui.visualMarkup(p, diff);
    expect(matchMedia).toHaveBeenCalledWith('(pointer: coarse), (max-width: 760px)');
    expect(html).toContain('<span class="visual-pan-hint">' + hint + '</span>');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).not.toMatch(/pinch/i);
  });
});

describe('selected node halos', () => {
  const colors = {
    conflict: '#dc9419',
    modified: '#2f6fed',
    moved: '#7a6fb0',
    added: '#2a9d4a',
    removed: '#c65353',
  };

  it('defines all five halo filters with the approved bounds, color and strength', () => {
    const ui = browserHelpers(),
      { p, diff } = chain([4]);
    const html = ui.visualMarkup(p, diff);
    const defs = html.match(/<defs>([\s\S]*?)<\/defs>/)![1]!;
    expect(defs.match(/<filter /g)).toHaveLength(5);
    for (const [kind, color] of Object.entries(colors)) {
      expect(defs).toContain(
        `<filter id="halo-${kind}" x="-50%" y="-150%" width="200%" height="400%"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="${color}" flood-opacity="1"/></filter>`
      );
    }
  });

  it.each(Object.keys(colors))(
    'layers the selected %s glow behind the node and its crisp outline above it',
    kind => {
      const ui = browserHelpers(),
        { p, diff } = chain([4]);
      const n = {
        ...ui.visualGraph(p, diff).byId.n4,
        kind,
        type: 'inject',
        input: true,
        outputs: 1,
      };
      const html = ui.visualNodeSvg(n, { selected: n.id }, false);
      const glow = html.match(/<rect class="selection-glow"[^>]*\/>/)![0];
      const outline = html.match(/<rect class="change-outline"[^>]*\/>/)![0];
      expect(html.indexOf(glow)).toBe(html.indexOf('>') + 1);
      expect(html.indexOf(glow)).toBeLessThan(html.indexOf('class="node-body"'));
      expect(glow).toContain(`filter="url(#halo-${kind})"`);
      expect(glow).toContain('pointer-events="none"');
      for (const attr of ['x', 'y', 'width', 'height', 'rx', 'stroke', 'stroke-width']) {
        expect(glow.match(new RegExp(` ${attr}="[^"]*"`))![0]).toBe(
          outline.match(new RegExp(` ${attr}="[^"]*"`))![0]
        );
      }
      expect(outline).toContain('stroke-width="3.75"');
      expect(outline).not.toMatch(/filter=|stroke-dasharray=/);
      expect(html.match(/ filter=/g)).toHaveLength(1);
      expect(html.indexOf(outline)).toBeGreaterThan(html.lastIndexOf('stroke-dasharray="none"'));
      expect(html.indexOf(outline)).toBeGreaterThan(html.indexOf('</text>'));
      expect(html.indexOf(outline)).toBeLessThan(html.indexOf('<circle'));

      const unselected = ui.visualNodeSvg(n, {}, false);
      expect(unselected).not.toMatch(/selection-glow|filter=/);
      const unselectedOutline = unselected.match(/<rect class="change-outline"[^>]*\/>/)![0];
      expect(unselectedOutline.includes('stroke-dasharray="6,4"')).toBe(
        kind === 'conflict' || kind === 'removed'
      );
      expect(unselectedOutline).not.toContain('filter=');
      expect(ui.visualNodeSvg({ ...n, kind: null }, { selected: n.id }, false)).not.toMatch(
        /selection-glow|change-outline|filter=/
      );
    }
  );
});

describe('proposal summaries and deploy controls', () => {
  it('shares counts between API, list and detail, including moved, rewired, config and conflict nodes', () => {
    const before = {
      nodes: [
        { id: 'move', type: 'function', x: 1, y: 120 },
        { id: 'wire', type: 'inject', wires: [[]] },
        { id: 'remove', type: 'debug' },
      ],
      configs: [{ id: 'config', type: 'mqtt-broker', port: 1883 }],
    };
    const after = {
      nodes: [
        { id: 'move', type: 'function', x: 2, y: 120 },
        { id: 'wire', type: 'inject', wires: [['move']] },
        { id: 'add', type: 'debug' },
      ],
      configs: [{ id: 'config', type: 'mqtt-broker', port: 8883 }],
    };
    const p = {
      id: 'p',
      type: 'replace_flow',
      status: 'conflict',
      createdAt: '2026-11-10T01:00:00Z',
      createdBy: { kind: 'access-link', linkId: 'agent' },
      payload: { flowId: 'tab', flow: after },
      baseFlow: before,
      rebase: { state: 'conflict', conflicts: [{ nodeId: 'move' }, { nodeId: 'move' }] },
    } as Proposal;
    const counts = proposalChangeCounts(p),
      summary = buildDiffSections(after, before).summary;
    expect(counts).toEqual({ added: 1, removed: 1, modified: 2, moved: 1, conflict: 1 });
    expect(counts).toMatchObject({
      added: summary.added,
      removed: summary.removed,
      modified: summary.modified,
      moved: summary.moved,
    });
    expect(presentProposalForApi(p).changeCounts).toEqual(counts);
    expect(
      proposalChangeCounts({ ...p, status: 'pending', rebase: { ...p.rebase!, state: 'merged' } })
        .conflict
    ).toBe(0);
    const ui = browserHelpers();
    const detail = ui.visualMarkup(p, { ...buildDiffSections(after, before), rebase: p.rebase });
    for (const [kind, count] of Object.entries(counts)) {
      expect(detail).toContain('<span>' + count + ' ' + kind + '</span>');
      expect(ui.renderChangeCounts(counts)).toContain('title="' + count + ' ' + kind + '"');
    }
    expect(ui.renderCompactProposal(presentProposalForApi(p))).toContain(
      ui.renderChangeCounts(counts)
    );
    const a = { nodes: [{ id: 'n', type: 'function', value: { a: 1, b: 2 } }] };
    const b = { nodes: [{ id: 'n', type: 'function', value: { b: 2, a: 1 } }] };
    expect(flowChangeCounts(a, b).modified).toBe(0);
    expect(buildDiffSections(b, a).summary.modified).toBe(0);
  });

  it('renders summary rows without action buttons, with warnings immediately after the title and pending-only rebase chips', () => {
    const ui = browserHelpers();
    const p = {
      id: 'p',
      title: 'Test title',
      status: 'pending',
      createdBy: { label: 'agent' },
      createdAt: '2026-11-10',
      flowLabel: 'Main',
      deployPending: {},
      rebase: { state: 'clean' },
      changeCounts: { added: 2, removed: 1, modified: 3, moved: 2, conflict: 1 },
    };
    const html = ui.renderCompactProposal(p);
    expect(html).toMatch(/<strong[^>]*>[^<]*<\/strong><span class="proposal-inline-warning"/);
    expect(html).toContain('title="Deploy pending"');
    expect(html).toContain('aria-label="Deploy pending"');
    expect(html).toContain('data-icon="deploy-pending"');
    for (const kind of ['added', 'removed', 'modified', 'moved', 'conflict']) {
      expect(html).toContain('data-icon="' + kind + '"');
    }
    expect(html).toContain('title="2 moved"');
    expect(html).not.toMatch(/[✎⚠✓•]/);
    expect(html).toContain('role="button" tabindex="0"');
    expect(html).toContain(
      '<span class="row-chevron" aria-hidden="true">→</span></div><div class="proposal-row-meta">'
    );
    expect(html).not.toContain('›');
    expect(html).toMatch(/<span class="proposal-by"[^>]*>Created by agent · [^<]+<\/span>/);
    expect(html).not.toContain('<time');
    expect(html).toContain('<span class="flow-name">Main</span>');
    expect(html).toContain('<strong data-title-for="p">Test title</strong>');
    expect(html).not.toContain('Test title in Main');
    expect(ui.displayTitleForProposal(p, { summary: { modified: 1 } })).toBe('Test title');
    expect(html).toContain('Rebase: clean');
    expect(html).not.toMatch(/approve-btn|reject-btn|Approve|Reject|proposal-detail|<button/);
    expect(ui.renderCompactProposal({ ...p, status: 'approved' })).not.toContain('rebase-chip');
    for (const status of ['approved', 'rejected', 'failed', 'withdrawn', 'expired', 'superseded'])
      expect(ui.proposalMatchesFilter({ status }, 'resolved')).toBe(true);
    expect(ui.proposalMatchesFilter({ status: 'conflict' }, 'pending')).toBe(true);
    expect(ui.proposalMatchesFilter({ status: 'conflict' }, 'conflict')).toBe(true);
    expect(ui.proposalMatchesFilter({ status: 'pending' }, 'pending')).toBe(true);
    expect(ui.proposalMatchesFilter({ status: 'pending' }, 'all')).toBe(true);
    for (const conflict of [
      { status: 'pending', rebase: { state: 'conflict' } },
      { status: 'conflict' },
    ]) {
      const markup = ui.renderCompactProposal({ ...p, ...conflict });
      expect(markup).toContain('class="status-pill pending">pending</span>');
      expect(markup).toContain('class="rebase-chip conflict">Conflict</span>');
      expect(ui.proposalMatchesFilter(conflict, 'pending')).toBe(true);
      expect(ui.proposalMatchesFilter(conflict, 'conflict')).toBe(true);
    }
  });

  it.each(['#/proposals/p', '#proposal=p'])(
    'preserves the list filter and search after a detail action via %s',
    hash => {
      const ui = browserHelpers();
      ui.setListState('conflict', 'my title', hash);
      ui.setDiff({ id: 'p', status: 'approved' }, {});
      ui.settleSearchAfterAction('p', 'approved');
      expect(ui.getListState()).toEqual(['conflict', 'my title']);
    }
  );

  it('disambiguates matching custom titles across flows without adding flow suffixes', () => {
    const ui = browserHelpers();
    const titles = ui.buildDisambiguatedTitles([
      { id: 'a', title: 'Tighten parsing', flowLabel: 'Hello', createdAt: '2026-11-10T01:00:00Z' },
      {
        id: 'b',
        title: 'Tighten parsing',
        flowLabel: 'Event pipeline',
        createdAt: '2026-11-10T01:00:00Z',
      },
    ]);
    expect(titles.a).toMatch(/^Tighten parsing · \d{2}:\d{2} #1$/);
    expect(titles.b).toMatch(/^Tighten parsing · \d{2}:\d{2} #2$/);
  });

  it('hides list chrome on detail routes and restores it on return', () => {
    const elements = Object.fromEntries(
      ['proposals-list-header', 'proposals-filters', 'proposals-list', 'proposal-detail-page'].map(
        id => [id, { hidden: false, querySelectorAll: () => [] }]
      )
    );
    const ui = browserHelpers(elements);
    ui.syncProposalRoute('p');
    for (const id of ['proposals-list-header', 'proposals-filters', 'proposals-list'])
      expect(elements[id].hidden).toBe(true);
    expect(elements['proposal-detail-page'].hidden).toBe(false);
    ui.syncProposalRoute('');
    for (const id of ['proposals-list-header', 'proposals-filters', 'proposals-list'])
      expect(elements[id].hidden).toBe(false);
    expect(elements['proposal-detail-page'].hidden).toBe(true);
  });

  it.each(['nodes', 'flows', 'full'])(
    'defaults the split button from Settings (%s) and submits the selected type only on Approve',
    async type => {
      const ui = browserHelpers(),
        p = { id: 'p', status: 'pending' },
        diff = { summary: { modified: 1 }, rebase: { state: 'clean' } };
      ui.setPermission(true);
      ui.setDefault(type);
      ui.setDiff(p, diff);
      const html = ui.renderReviewActionRow(p, false);
      expect(html).toMatch(new RegExp('data-deploy="' + type + '" class="selected"'));
      expect([...html.matchAll(/data-deploy="([^"]+)"/g)].map(m => m[1])).toEqual([
        'full',
        'flows',
        'nodes',
      ]);
      expect(html).toContain('aria-haspopup="menu"');
      expect(html).toContain('class="approve-split"');
      expect(html).toContain('>Reject</button>');
      expect(html).not.toContain('proposal-history-notice');
      expect(html).not.toMatch(/class="action approve-btn"[^>]*disabled/);
      const approve = vi.fn();
      ui.setApprove(approve);
      ui.setDeploy('p', 'flows');
      expect(approve).not.toHaveBeenCalled();
      await ui.approveProposal('p');
      expect(approve).toHaveBeenCalledWith('p', 'flows');
      const blockedHtml = ui.renderReviewActionRow({ ...p, status: 'conflict' }, true);
      expect(blockedHtml).toMatch(/class="action approve-btn"[^>]*disabled/);
      expect(blockedHtml).toMatch(/class="approve-options"[^>]*disabled/);
      expect(blockedHtml).toContain('>Reject</button>');
      expect(blockedHtml).not.toContain('proposal-history-notice');
      ui.setPermission(false);
      expect(ui.renderReviewActionRow(p, false)).toMatch(/class="approve-options"[^>]*disabled/);
    }
  );

  it.each(['approved', 'rejected', 'failed', 'withdrawn', 'expired', 'superseded'])(
    'shows a history notice instead of decision controls and retains Visual View for %s',
    status => {
      const ui = browserHelpers();
      const { p: flow, diff } = chain([2]);
      const p = { ...flow, status };
      ui.setPermission(true);
      ui.setDefault('full');
      ui.setDiff(p, diff);
      for (const width of [1280, 375]) {
        ui.setViewport(width);
        const row = ui.renderReviewActionRow(p, false);
        expect(row).toContain(
          '<p class="proposal-history-notice">Historical record — may no longer match the live flow.</p>'
        );
        expect(row).toMatch(/back-proposals">← Proposals<\/button>.*proposal-history-notice/);
        expect(row.match(/<button\b/g)).toHaveLength(1);
        expect(row).not.toMatch(/Approve|Reject|approve-|reject-|full-deploy-warn|hidden/);
        const card = ui.renderProposalCard(p);
        expect(card).toContain(row);
        expect(card).toContain('class="status-pill ' + status + '">' + status + '</span>');
        expect(card).toContain('class="proposal-visual-host"');
        const visual = ui.visualMarkup(p, diff);
        for (const part of ['visual-canvas', 'visual-legend', 'Changed nodes', 'data-diff-for="p"'])
          expect(visual).toContain(part);
        const graph = ui.visualGraph(p, diff);
        const drawer = ui.renderVisualNodeDrawer(
          graph.nodes.find((n: any) => n.kind),
          p,
          diff
        );
        expect(drawer).toContain('class="drawer" aria-label="Node change details"');
        expect(drawer).toContain('func');
      }
    }
  );
});

describe('proposal search pagination and cross-filter hints', () => {
  function searchUi() {
    const list = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
    const ui = browserHelpers({ 'proposals-list': list });
    return { ui, list };
  }

  it.each([
    ['pending', '', 'filter'],
    ['conflict', '', 'filter'],
    ['resolved', '', 'filter'],
    ['all', 'missing', 'search'],
  ])('centres the empty state for %s with query "%s"', (filter, query, subject) => {
    const { ui, list } = searchUi();
    ui.setSearch(filter, query, [], false);
    ui.renderProposalsList();
    expect(list.innerHTML).toContain('<h2 class="empty-title">All clear here</h2>');
    expect(list.innerHTML).toContain('No proposals match this ' + subject + '.');
    expect(pageStyles()).toContain(
      '#proposals-list .empty-state { padding: 65px 20px; text-align: center;'
    );
  });

  it.each([1, 2])('marks %i loaded Resolved matches as partial until pagination ends', count => {
    const { ui, list } = searchUi();
    const proposals = [
      { id: 'p', title: 'needle', status: 'pending' },
      ...Array.from({ length: count }, (_, i) => ({
        id: 'r' + i,
        title: 'needle',
        status: 'approved',
      })),
    ];
    ui.setSearch('conflict', 'needle', proposals, true);
    ui.renderProposalsList();
    expect(list.innerHTML).toContain(count + '+ matches in Resolved');
    expect(list.innerHTML).toContain('1 match in Pending');
    ui.setSearch('conflict', 'needle', proposals, false);
    ui.renderProposalsList();
    expect(list.innerHTML).toContain(
      count + (count === 1 ? ' match' : ' matches') + ' in Resolved'
    );
    expect(list.innerHTML).not.toContain('+ matches');
  });

  it.each(['resolved', 'all'])(
    'searches every decided page on %s and shows progress while loading',
    async filter => {
      const { ui, list } = searchUi();
      ui.setSearch(filter, 'needle', [], true);
      let finish: (data: unknown) => void = vi.fn();
      const api = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              finish = resolve;
            })
        )
        .mockResolvedValueOnce({
          proposals: [{ id: 'needle', status: 'approved' }],
          hasMore: false,
        });
      ui.setApi(api);
      ui.renderProposalsList();
      expect(list.innerHTML).toContain('Searching all decided proposals…');
      expect(list.innerHTML).not.toContain('id="decided-load-more"');
      ui.renderProposalsList();
      expect(api).toHaveBeenCalledTimes(1);
      finish({ proposals: [{ id: 'other', status: 'rejected' }], hasMore: true });
      await vi.waitFor(() => expect(list.innerHTML).toContain('data-id="needle"'));
      expect(api.mock.calls.map(call => call[0])).toEqual([
        expect.stringContaining('&offset=0'),
        expect.stringContaining('&offset=1'),
      ]);
      expect(list.innerHTML).not.toContain('Searching all decided proposals…');
    }
  );

  it.each(['resolved', 'all'])('keeps manual pagination when %s is not searching', filter => {
    const { ui, list } = searchUi();
    const api = vi.fn();
    ui.setApi(api);
    ui.setSearch(filter, '', [], true);
    ui.renderProposalsList();
    expect(list.innerHTML).toContain('id="decided-load-more"');
    expect(api).not.toHaveBeenCalled();
  });

  it('shows other matching filters with their real ids and switches to each one', () => {
    const { ui, list } = searchUi();
    const proposals = [
      { id: 'p', title: 'needle', status: 'pending' },
      { id: 'c', title: 'needle', status: 'conflict' },
      { id: 'r1', title: 'needle', status: 'approved' },
      { id: 'r2', title: 'needle', status: 'rejected' },
    ];
    for (const [filter, label, count] of [
      ['pending', 'Pending', 2],
      ['conflict', 'Conflict', 1],
      ['resolved', 'Resolved', 2],
    ] as const) {
      ui.setSearch(
        filter,
        'needle',
        proposals.filter(p => !ui.proposalMatchesFilter(p, filter)),
        false
      );
      ui.renderProposalsList();
      expect(list.innerHTML).toContain('class="cross-tab-hint"');
      expect(list.innerHTML).not.toContain('Switch to ' + label);
      ui.setSearch('pending', 'needle', proposals, false);
      let click: () => void = vi.fn();
      ui.bindCrossTabHint({
        querySelectorAll: () => [
          {
            getAttribute: (name: string) => (name === 'data-filter' ? filter : null),
            setAttribute: vi.fn(),
            addEventListener: (_event: string, fn: () => void) => {
              click = fn;
            },
          },
        ],
      });
      click();
      expect(ui.getFilter()).toBe(filter);
      expect(ui.countSearchMatchesInFilter(filter)).toBe(count);
      // A missing current match exposes the labels and pluralization for every other filter.
      ui.setSearch(
        filter === 'resolved' ? 'pending' : 'resolved',
        'needle',
        proposals.filter(p => ui.proposalMatchesFilter(p, filter)),
        false
      );
      ui.renderProposalsList();
      expect(list.innerHTML).toContain(`${count} ${count === 1 ? 'match' : 'matches'} in ${label}`);
      expect(list.innerHTML).toContain(`data-filter="${filter}">Switch to ${label}`);
      expect(list.innerHTML).not.toContain('Decided');
    }
    ui.setSearch('all', 'absent', proposals, false);
    ui.renderProposalsList();
    expect(list.innerHTML).not.toContain('cross-tab-hint');
  });

  it('stops failed search pagination without an immediate retry loop', async () => {
    const { ui, list } = searchUi();
    ui.setSearch('resolved', 'needle', [], true);
    const api = vi.fn().mockRejectedValue(new Error('Offline'));
    ui.setApi(api);
    ui.renderProposalsList();
    await vi.waitFor(() => expect(list.innerHTML).toContain('id="decided-load-more"'));
    expect(api).toHaveBeenCalledTimes(1);
  });
});

describe('review action safety', () => {
  it.each(['conflict', 'permission', 'no-op', 'loading'])(
    'disables both Approve buttons for %s and enables both when ready',
    reason => {
      const ui = browserHelpers();
      const p = { id: 'p', status: 'pending' };
      const diff = { summary: { modified: 1 }, rebase: { state: 'clean' } };
      ui.setPermission(reason !== 'permission');
      ui.setDiff(
        p,
        reason === 'loading'
          ? null
          : reason === 'no-op'
            ? { ...diff, vsCurrent: { summary: {} } }
            : diff
      );
      const blocked = ui.renderReviewActionRow(p, reason === 'conflict');
      for (const cls of ['action approve-btn', 'approve-options'])
        expect(blocked).toMatch(new RegExp('class="' + cls + '"[^>]*disabled'));
      ui.setPermission(true);
      ui.setDiff(p, diff);
      expect(ui.renderReviewActionRow(p, false)).not.toMatch(/ disabled/);
      expect(pageStyles()).toMatch(/\.approve-split button:disabled\s*\{[^}]*opacity: \.45;/);
    }
  );

  it('synchronizes the caret with Approve and closes an open menu when disabled', () => {
    const approve = { disabled: true };
    const attributes: Record<string, string> = { 'aria-expanded': 'true' };
    const toggle = {
      disabled: false,
      addEventListener: vi.fn(),
      getAttribute: (key: string) => attributes[key],
      setAttribute: (key: string, value: string) => {
        attributes[key] = value;
      },
      onkeydown: vi.fn(),
    };
    const focus = vi.fn();
    const menu = {
      hidden: false,
      querySelector: () => ({ focus }),
      onclick: vi.fn(),
    };
    const wrap = {
      querySelector: (selector: string) =>
        selector === '.approve-btn' ? approve : selector === '.approve-options' ? toggle : menu,
    };
    const ui = browserHelpers();
    const host = {
      querySelectorAll: (selector: string) => (selector === '.approve-wrap' ? [wrap] : []),
    };
    ui.bindReviewControls(host);
    expect(toggle.disabled).toBe(true);
    expect(menu.hidden).toBe(true);
    expect(attributes['aria-expanded']).toBe('false');
    toggle.onkeydown({ key: 'ArrowDown', preventDefault: vi.fn() });
    menu.onclick({
      target: {
        closest: () => {
          throw new Error('Disabled menu is interactive');
        },
      },
    });
    expect(menu.hidden).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    approve.disabled = false;
    ui.bindReviewControls(host);
    expect(toggle.disabled).toBe(false);
    toggle.onkeydown({ key: 'ArrowDown', preventDefault: vi.fn() });
    expect(menu.hidden).toBe(false);
    expect(attributes['aria-expanded']).toBe('true');
    expect(focus).toHaveBeenCalledOnce();
  });

  it('collapses summary, review notes and reason before the counts and workspace', () => {
    const ui = browserHelpers();
    const { p: flow, diff } = chain([2]);
    const p = {
      ...flow,
      status: 'pending',
      reason: 'Review the change carefully. '.repeat(100),
      warnings: Array.from({ length: 20 }, (_, i) => ({
        code: 'config_' + i,
        error: 'Needs configuration',
      })),
    };
    ui.setDiff(p, diff);
    const html = ui.renderProposalCard(p);
    const notes = html
      .split('<details class="proposal-notes">')[1]
      ?.split('<div class="proposal-visual-host"')[0];
    expect(notes).toContain('<summary>Notes</summary>');
    expect(notes).toContain('proposal-plain-summary');
    expect(notes).toContain('proposal-review-notes');
    expect(notes).toContain('Reason:');
    expect(html.indexOf('class="proposal-actions"')).toBeLessThan(
      html.indexOf('class="proposal-notes"')
    );
    expect(html.indexOf('class="proposal-notes"')).toBeLessThan(
      html.indexOf('class="proposal-visual-host"')
    );
    expect(ui.visualMarkup(p, diff)).toMatch(
      /<div class="visual-summary">[\s\S]*?<\/div><section class="visual-workspace"/
    );
  });

  it.each(['bogus', '', null])(
    'falls back to nodes for an invalid deploy default or selection: %s',
    async invalid => {
      const ui = browserHelpers(),
        p = { id: 'p', status: 'pending' };
      ui.setPermission(true);
      ui.setDiff(p, { summary: { modified: 1 } });
      ui.setDefault(invalid);
      expect(ui.renderReviewActionRow(p, false)).toContain('data-deploy="nodes" class="selected"');
      ui.setDefault('flows');
      ui.setDeploy('p', invalid);
      expect(ui.renderReviewActionRow(p, false)).toContain('data-deploy="nodes" class="selected"');
      const approve = vi.fn();
      ui.setApprove(approve);
      await ui.approveProposal('p');
      expect(approve).toHaveBeenCalledWith('p', 'nodes');
    }
  );

  it('uses current cached status when the deploy menu re-renders', () => {
    const ui = browserHelpers(),
      old = { id: 'p', status: 'pending' };
    ui.setDetails(old);
    ui.setPermission(true);
    ui.setDiff({ ...old, status: 'approved' }, { summary: { modified: 1 } });
    const actions = {
      innerHTML: '',
      querySelectorAll: () => [],
      querySelector: (selector: string) => (selector === '.back-proposals' ? back : null),
    };
    const back = { focus: vi.fn() };
    const menu = { onclick: vi.fn(), querySelector: () => ({ focus: vi.fn() }) };
    const wrap = {
      querySelector: (selector: string) =>
        selector === '[role="menu"]'
          ? menu
          : { getAttribute: () => 'p', setAttribute: vi.fn(), addEventListener: vi.fn() },
      closest: () => actions,
    };
    ui.bindReviewControls({
      querySelectorAll: (selector: string) => (selector === '.approve-wrap' ? [wrap] : []),
    });
    menu.onclick({ target: { closest: () => ({ getAttribute: () => 'flows' }) } });
    expect(actions.innerHTML).toContain('proposal-history-notice');
    expect(actions.innerHTML).not.toMatch(/approve-|reject-/);
    expect(back.focus).toHaveBeenCalledOnce();
  });

  it('keeps the deletion confirmation usable and starts the guard only after typed confirmation', async () => {
    let submit: (ev: any) => void = vi.fn();
    const input = { value: '', addEventListener: vi.fn() };
    const ui = browserHelpers({
      'delete-confirm-input': input,
      'delete-confirm-form': {
        addEventListener: (_event: string, fn: typeof submit) => {
          submit = fn;
        },
      },
    });
    const p = { id: 'p', status: 'pending' };
    ui.setPermission(true);
    ui.setDiff(p, { summary: { removed: 2, beforeNodeCount: 2, afterNodeCount: 0 } });
    let finish: () => void = vi.fn();
    const request = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    ui.setAction(request, request);
    ui.setupDialogs();
    await ui.approveProposal('p');
    expect(ui.pendingCount()).toBe(0);
    expect(ui.renderReviewActionRow(p, false)).not.toMatch(/ disabled/);
    submit({ submitter: { value: 'confirm' } });
    expect(request).not.toHaveBeenCalled();
    await ui.approveProposal('p');
    input.value = 'DELETE';
    submit({ submitter: { value: 'confirm' } });
    expect(ui.pendingCount()).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(ui.pendingCount()).toBe(0));
  });

  it('releases the guard for deployment-outcome confirmation and guards the override request', async () => {
    let confirm: (ev: any) => void = vi.fn();
    const ui = browserHelpers({
      'confirm-form': {
        addEventListener: (_event: string, fn: typeof confirm) => {
          confirm = fn;
        },
      },
    });
    const p = { id: 'p', status: 'pending' };
    ui.setPermission(true);
    ui.setDiff(p, { summary: { modified: 1 } });
    ui.setupDialogs();
    let fail: (err: unknown) => void = vi.fn();
    const api = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        })
    );
    ui.setApi(api);
    const pending = ui.doApproveProposal('p', 'nodes');
    fail({ body: { code: 'deploy_outcome_unknown' } });
    await pending;
    expect(ui.pendingCount()).toBe(0);
    expect(ui.renderReviewActionRow(p, false)).not.toMatch(/ disabled/);
    let finish: () => void = vi.fn();
    const override = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    ui.setAction(override, vi.fn());
    confirm({ submitter: { value: 'confirm' } });
    expect(override).toHaveBeenCalledWith('p', 'nodes', true);
    expect(ui.pendingCount()).toBe(1);
    await ui.doApproveProposal('p', 'nodes', true);
    expect(override).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(ui.pendingCount()).toBe(0));
  });

  it.each(['approve', 'reject'])(
    'guards duplicate and opposing requests while %s is pending, then restores controls',
    async action => {
      const actions = { innerHTML: '', querySelectorAll: () => [] };
      const article = { getAttribute: () => 'p', querySelector: () => actions };
      const ui = browserHelpers({}, [article]),
        p = { id: 'p', status: 'pending' };
      ui.setPermission(true);
      ui.setDiff(p, { summary: { modified: 1 } });
      let finish: () => void = vi.fn();
      const request = vi.fn(
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          })
      );
      ui.setAction(request, request);
      const pending =
        action === 'approve' ? ui.doApproveProposal('p', 'nodes') : ui.rejectProposal('p');
      for (const cls of ['action approve-btn', 'approve-options', 'action secondary reject-btn'])
        expect(actions.innerHTML).toMatch(new RegExp('class="' + cls + '"[^>]*disabled'));
      await ui.doApproveProposal('p', 'nodes');
      await ui.rejectProposal('p');
      expect(request).toHaveBeenCalledTimes(1);
      expect(ui.pendingCount()).toBe(1);
      finish();
      await pending;
      expect(ui.pendingCount()).toBe(0);
      expect(actions.innerHTML).not.toMatch(/ disabled/);
      ui.setAction(
        () => Promise.reject(new Error('Offline')),
        () => Promise.reject(new Error('Offline'))
      );
      await expect(ui.doApproveProposal('p', 'nodes')).rejects.toThrow('Offline');
      expect(actions.innerHTML).not.toMatch(/ disabled/);
      expect(ui.pendingCount()).toBe(0);
    }
  );
});

describe('Moved classification and review', () => {
  const original = {
    id: 'move',
    type: 'function',
    x: 100,
    y: 120,
    func: 'return msg;',
    wires: [[]],
  };

  it.each([
    [{ x: 300 }, ['x'], 'moved'],
    [{ y: 240 }, ['y'], 'moved'],
    [{ x: 300, y: 240 }, ['x', 'y'], 'moved'],
    [{ x: 300, func: 'return null;' }, ['func', 'x'], 'modified'],
    [{ wires: [['target']] }, ['wires'], 'modified'],
    [{ x: 300, wires: [['target']] }, ['wires', 'x'], 'modified'],
    [{}, [], 'unchanged'],
  ])('classifies %j after retaining all changed keys', (patch, keys, kind) => {
    const node = { ...original, ...patch };
    expect(changedNodeKeys(original, node)).toEqual(keys);
    expect(isMoveOnly(original, node, keys)).toBe(kind === 'moved');
    const before = { nodes: [original] },
      after = { nodes: [node] };
    const counts = flowChangeCounts(before, after);
    expect(counts).toEqual({
      added: 0,
      removed: 0,
      modified: Number(kind === 'modified'),
      moved: Number(kind === 'moved'),
    });
    const diff = buildDiffSections(after, before);
    expect(diff.summary).toMatchObject(counts);
    if (kind === 'modified') expect(diff.modified[0]?.changes.map(ch => ch.key)).toEqual(keys);
    if (kind === 'moved')
      expect(diff.moved).toEqual([
        {
          id: 'move',
          type: 'function',
          before: { x: 100, y: 120 },
          after: { x: node.x, y: node.y },
        },
      ]);
  });

  it.each([
    [
      { x: '100', y: 120 },
      { x: 100, y: 120 },
    ],
    [
      { x: 100, y: 120 },
      { x: '100', y: 120 },
    ],
    [{ x: 100, y: 120 }, {}],
    [{ x: 100, y: 120 }, { y: 120 }],
    [{ x: 100, y: 120 }, { x: 100 }],
    [{}, { x: 100, y: 120 }],
    [{ y: 120 }, { x: 100, y: 120 }],
    [{ x: 100 }, { x: 100, y: 120 }],
    [{ x: 100 }, { x: 300 }],
    [
      { x: 100, y: 120 },
      { x: NaN, y: 120 },
    ],
    [
      { x: Infinity, y: 120 },
      { x: 100, y: 120 },
    ],
    [
      { x: 100, y: 120 },
      { x: 100, y: -Infinity },
    ],
    [
      { x: 100, y: NaN },
      { x: 300, y: NaN },
    ],
    [
      { x: 100, y: null },
      { x: 300, y: null },
    ],
    [
      { x: 100, y: '120' },
      { x: 300, y: '120' },
    ],
  ])('classifies invalid coordinates %j → %j as Modified', (beforePosition, afterPosition) => {
    const beforeNode: FlowNode = { id: 'move', type: 'function', ...beforePosition };
    const afterNode: FlowNode = { id: 'move', type: 'function', ...afterPosition };
    const before = { nodes: [beforeNode] },
      after = { nodes: [afterNode] };
    expect(isMoveOnly(beforeNode, afterNode)).toBe(false);
    const counts = { added: 0, removed: 0, modified: 1, moved: 0 };
    expect(flowChangeCounts(before, after)).toEqual(counts);
    const diff = buildDiffSections(after, before);
    expect(diff.summary).toMatchObject(counts);
    expect(diff.modified).toHaveLength(1);
    expect(diff.moved).toEqual([]);
    const p = {
      id: 'p',
      type: 'replace_flow',
      status: 'pending',
      createdAt: '2026-11-10T01:00:00Z',
      createdBy: { kind: 'access-link', linkId: 'agent' },
      baseFlow: before,
      payload: { flowId: 'tab', flow: after },
    } as Proposal;
    expect(proposalChangeCounts(p)).toMatchObject(counts);
    expect(presentProposalForApi(p)).toMatchObject({
      title: 'Edit function',
      changeSummary: 'Edits 1 node',
      changeCounts: counts,
    });
  });

  function mount(
    patch: Record<string, unknown> = {},
    resolved = false,
    additionalMove = false,
    overlayOpen = false
  ) {
    const extra = additionalMove ? [{ ...original, id: 'second', y: 400 }] : [];
    const p = {
      id: 'p',
      title: 'Update flow',
      status: 'pending',
      baseFlow: { nodes: [original, ...extra] },
      // These rendering cases exercise arrows from base to a live destination.
      visualLiveFlow: {
        nodes: [{ ...original, x: patch.x ?? 300, y: patch.y ?? 240, func: 'editor change' }],
      },
      payload: {
        flowId: 'tab',
        flow: {
          nodes: [
            { ...original, x: 300, y: 240, ...patch },
            ...extra.map(n => ({ ...n, x: 500, y: 500 })),
          ],
        },
      },
      ...(resolved ? { conflictChoice: { nodeId: 'move', choice: 'proposed' } } : {}),
    };
    const sections = buildDiffSections(p.payload.flow, p.baseFlow);
    const diff = { ...sections, rebase: { state: 'clean' }, vsCurrent: sections };
    const viewport = { innerHTML: '', setAttribute: vi.fn() };
    const rows = { innerHTML: '' };
    const svg = {
      addEventListener: vi.fn(),
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
    };
    const showAll = {
      onclick: () =>
        diffHost.onclick!({
          target: { closest: (selector: string) => (selector === '.visual-show-all' ? {} : null) },
        }),
    };
    const diffHost = {
      innerHTML: '',
      onclick: null as any,
      querySelector: (selector: string) => (selector === '.visual-node-diff' ? diffHost : showAll),
      querySelectorAll: () => [],
    };
    const slots: Record<string, any> = {
      '.visual-canvas': svg,
      '.visual-viewport': viewport,
      '.visual-canvas-wrap': { clientWidth: 600, clientHeight: 350 },
      '.visual-zoom': {},
      '.visual-list-count': {},
      '.visual-node-list': rows,
    };
    const host = {
      innerHTML: '',
      querySelector: (selector: string) => slots[selector],
      querySelectorAll: () => [],
      onclick: null as any,
    };
    let resize: () => void = vi.fn();
    const ui = browserHelpers(
      {
        '[data-visual-for="p"]': host,
        '[data-diff-for="p"]': diffHost,
        'dialog[open], #mobile-menu:not([hidden]), #approve-menu:not([hidden])': overlayOpen
          ? {}
          : null,
      },
      [],
      undefined,
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
    ui.setApi(() => Promise.resolve({}));
    ui.mountProposalVisual(p, diff);
    const click = (selector: string, attr: string) =>
      host.onclick({
        detail: 0,
        target: {
          closest: (query: string) => (query === selector ? { getAttribute: () => attr } : null),
        },
      });
    const view = () => {
      const transform = viewport.setAttribute.mock.calls.at(-1)![1];
      const [, x, y, k] = transform.match(/translate\(([^,]+),([^)]+)\) scale\(([^)]+)\)/)!;
      return { x: Number(x), y: Number(y), k: Number(k) };
    };
    const screenPosition = () => {
      const [, x, y] = /data-visual-node="move"[^>]*transform="translate\(([^,]+),([^)]+)\)"/.exec(
        viewport.innerHTML
      )!;
      const n = ui.visualGraph(p, diff).byId.move;
      const v = view();
      return { x: (Number(x) + n.w / 2) * v.k + v.x, y: (Number(y) + n.h / 2) * v.k + v.y };
    };
    const pan = (x: number, y: number) => {
      const listeners = new Map(svg.addEventListener.mock.calls.map(([event, fn]) => [event, fn]));
      listeners.get('pointerdown')!({
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        target: { closest: () => null },
      });
      listeners.get('pointermove')!({ pointerId: 1, clientX: x, clientY: y });
      listeners.get('pointerup')!();
    };
    return {
      ui,
      p,
      diff,
      viewport,
      rows,
      diffHost,
      host,
      showAll,
      click,
      view,
      screenPosition,
      pan,
      resize: () => resize(),
    };
  }

  it('centres a Changed-nodes row selection at the current zoom and opens its drawer', () => {
    const { click, pan, view, screenPosition, rows, viewport, diffHost } = mount();
    click('[data-visual-layout]', 'editor');
    pan(900, -600);
    const before = view();
    click('[data-visual-node]', 'move');
    expect(view()).not.toEqual(before);
    expect(view().k).toBe(before.k);
    expect(screenPosition().x).toBeCloseTo(300);
    expect(screenPosition().y).toBeCloseTo(175);
    expect(rows.innerHTML).toContain('moved selected');
    expect(viewport.innerHTML).toContain('selection-glow');
    expect(diffHost.innerHTML).toContain('MOVED NODE');
  });

  it('keeps a comfortably visible canvas selection in place and opens its drawer', () => {
    const { click, view, diffHost, viewport } = mount({ func: 'return null;' });
    const before = view();
    click('[data-visual-node]', 'move');
    expect(view()).toEqual(before);
    expect(viewport.innerHTML).toContain('selection-glow');
    expect(diffHost.innerHTML).toContain('MODIFIED NODE');
  });

  it.each(['Enter', ' '])('brings keyboard selections into view with %j', key => {
    const { host, pan, view, screenPosition, diffHost } = mount();
    pan(-900, 600);
    const before = view();
    const preventDefault = vi.fn();
    host.onkeydown({
      key,
      preventDefault,
      target: { closest: () => ({ hasAttribute: () => false, getAttribute: () => 'move' }) },
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(view().k).toBe(before.k);
    expect(screenPosition().x).toBeCloseTo(300);
    expect(screenPosition().y).toBeCloseTo(175);
    expect(diffHost.innerHTML).toContain('MOVED NODE');
  });

  it('holds the selected node still when switching layout modes', () => {
    const { click, pan, screenPosition } = mount();
    pan(900, -600);
    click('[data-visual-node]', 'move');
    const before = screenPosition();
    for (const layout of ['editor', 'compact']) {
      click('[data-visual-layout]', layout);
      expect(screenPosition().x).toBeCloseTo(before.x);
      expect(screenPosition().y).toBeCloseTo(before.y);
    }
  });

  it('preserves pan when refreshing the selected drawer diff mode', () => {
    const { click, pan, view, diffHost } = mount({ func: 'return null;' });
    click('[data-visual-node]', 'move');
    pan(900, -600);
    const before = view();
    diffHost.onclick({
      target: {
        closest: (selector: string) =>
          selector === '[data-diff-mode], [data-conflict-diff-mode]'
            ? { getAttribute: () => 'unified' }
            : null,
      },
    });
    expect(view()).toEqual(before);
    expect(diffHost.innerHTML).toContain('class="unified"');
  });

  it('places row type, name and arrow together above the summary', () => {
    const { rows } = mount({ func: 'return null;' }, true);
    expect(rows.innerHTML).toMatch(
      /<span class="visual-node-type">function<\/span><strong>[^<]+<\/strong><span class="visual-node-summary">/
    );
    expect(rows.innerHTML).toContain('Resolved · ');
    expect(rows.innerHTML).toContain('editor-merged-marker');
    const css = pageStyles();
    const rule = (selector: string) => css.slice(css.indexOf(selector + ' {')).split('}')[0];
    expect(rule('.visual-change-row')).toContain(
      'grid-template-columns: 18px 58px minmax(0,1fr) auto'
    );
    expect(rule('.visual-node-type')).toMatch(/grid-column: 2; grid-row: 1;/);
    expect(rule('.visual-change-row strong')).toMatch(/grid-column: 3; grid-row: 1;/);
    expect(rule('.visual-node-arrow')).toMatch(/grid-column: 4; grid-row: 1;/);
    expect(rule('.visual-node-summary')).toMatch(/grid-column: 2 \/ 5; grid-row: 2;/);
  });

  it.each([
    { name: 'down-right', patch: { x: 300, y: 240 }, shown: true },
    { name: 'long horizontal', patch: { x: 600, y: 120 }, shown: true },
    { name: 'modest vertical', patch: { x: 100, y: 180 }, shown: true },
    { name: 'short overlapping', patch: { x: 120, y: 130 }, shown: false },
    { name: 'small edge gap', patch: { x: 100, y: 165 }, shown: true },
    { name: 'real +120,+40 down-right', patch: { x: 220, y: 160 }, shown: true },
  ])('paints a $name move with the correct arrow visibility', ({ patch, shown }) => {
    const { viewport, host, click } = mount(patch);
    expect(viewport.innerHTML).not.toContain('class="move-arrow"');
    click('[data-visual-layout]', 'editor');
    const html = viewport.innerHTML;
    expect(html).toContain('move-ghost');
    expect(html.includes('class="move-arrow"')).toBe(shown);
    expect(html.includes('class="move-arrowhead"')).toBe(shown);
    expect(host.innerHTML).not.toContain('visual-move-tip');
    if (shown) {
      expect(html).toMatch(
        /class="move-arrow"[^>]*pointer-events="none"><path[^>]*stroke="#7a6fb0"[^>]*stroke-dasharray="6,5"/
      );
      expect(html).toMatch(/class="move-arrowhead" d="M[^L]+L[^L]+L[^Z]+Z" fill="#7a6fb0"/);
      expect(html.indexOf('move-ghost')).toBeLessThan(html.indexOf('class="move-arrow"'));
    }
  });

  it.each([false, true])('lands outside the painted body with selected=%s', selected => {
    const { viewport, click } = mount({ x: 600, y: 120 });
    click('[data-visual-layout]', 'editor');
    if (selected) click('[data-visual-node]', 'move');
    const html = viewport.innerHTML;
    const tip = /class="move-arrowhead" d="M([^ ]+) ([^L]+)L/.exec(html)!;
    const outline = /<rect class="change-outline"[^>]*>/.exec(html)![0];
    const width = Number(/width="([^"]+)"/.exec(outline)![1]) - 8;
    const pad = selected ? 5.875 : 5;
    expect(600 - Number(tip[1])).toBe(width / 2 + pad);
    expect(600 - Number(tip[1])).toBeGreaterThan(width / 2);
    expect(Number(tip[2])).toBe(120);
    expect(html.includes('class="selection-glow"')).toBe(selected);
  });

  it.each(['editor', 'compact'])(
    'marks only removed wires at the path midpoint in %s layout',
    layout => {
      const { ui, viewport, click } = mount();
      const source = {
        id: 'source',
        type: 'function',
        name: 'Create test message [3/3]',
        x: 450,
        y: 190,
        wires: [['target']],
      };
      const target = {
        id: 'target',
        type: 'debug',
        name: 'Visual multi · main output',
        x: 180,
        y: 80,
        wires: [],
      };
      const added = { id: 'added', type: 'debug', name: 'New debug', x: 750, y: 190, wires: [] };
      const before = { nodes: [source, target] };
      const after = { nodes: [{ ...source, wires: [['added']] }, target, added] };
      const p = { id: 'p', baseFlow: before, visualLiveFlow: before, payload: { flow: after } };
      const sections = buildDiffSections(after, before);
      ui.mountProposalVisual(p, { ...sections, rebase: { state: 'clean' }, vsCurrent: sections });
      click('[data-visual-layout]', layout);
      const html = viewport.innerHTML;
      const removed =
        /<path d="([^"]+)" fill="none" stroke="#c65353" stroke-width="3" stroke-dasharray="7,5"\/>/.exec(
          html
        );
      expect(removed).not.toBeNull();
      expect(html).toContain('stroke="#2a9d4a" stroke-width="3"');
      expect(html.match(/class="visual-removed-wire-mark"/g)).toHaveLength(1);
      const mark =
        /<g class="visual-removed-wire-mark" pointer-events="none" transform="translate\(([^,]+),([^)]+)\)"><circle r="8" fill="#fff"\/><path d="M-4 -4 L4 4 M4 -4 L-4 4" fill="none" stroke="#c65353" stroke-width="2\.5"\/><\/g>/.exec(
          html
        );
      expect(mark).not.toBeNull();
      const midpoint = runInNewContext(
        pageClientVisualGeometryScript() + '\nvisualLinkPathMidpoint;'
      )(removed![1]);
      expect(Number(mark![1])).toBe(midpoint.x);
      expect(Number(mark![2])).toBe(midpoint.y);
      expect(html.indexOf(mark![0])).toBeGreaterThan(html.indexOf(removed![0]));
      expect(html.indexOf(mark![0])).toBeLessThan(html.indexOf('class="visual-node'));
    }
  );

  it('paints every ghost before every arrow, then wires and live nodes', () => {
    const { viewport, click } = mount({ wires: [['second']] }, false, true);
    click('[data-visual-layout]', 'editor');
    const html = viewport.innerHTML;
    expect(html.match(/class="move-arrow"/g)).toHaveLength(2);
    expect(html.match(/move-ghost/g)).toHaveLength(2);
    expect(html.lastIndexOf('move-ghost')).toBeLessThan(html.indexOf('class="move-arrow"'));
    const wire = html.indexOf('stroke-width="3"');
    expect(html.lastIndexOf('class="move-arrow"')).toBeLessThan(wire);
    expect(wire).toBeLessThan(html.indexOf('class="visual-node changed"'));
  });

  it('clicks a Moved node to show positions, and returns to the Moved section with Show all changes', () => {
    const { ui, p, diff, rows, diffHost, host, showAll, click } = mount();
    expect(host.innerHTML).toContain('data-icon="moved"');
    expect(host.innerHTML).toContain('background:#7a6fb0');
    expect(host.innerHTML).toContain('1 moved');
    expect(rows.innerHTML).toContain('class="visual-change-row moved');
    expect(rows.innerHTML).toContain('data-icon="moved"');
    click('[data-visual-node]', 'move');
    expect(diffHost.innerHTML).toContain('Show all changes');
    expect(diffHost.innerHTML).toContain('(100, 120) → (300, 240)');
    expect(diffHost.innerHTML).not.toMatch(/Modified nodes|prop-change|Nothing changes/);
    showAll.onclick();
    expect(diffHost.innerHTML).toContain('<h4>Moved nodes</h4>');
    expect(diffHost.innerHTML).not.toContain('visual-diff-heading');
    ui.setPermission(true);
    ui.setDiff(p, diff);
    expect(ui.renderReviewActionRow(p, false)).not.toMatch(
      /class="action approve-btn"[^>]*disabled/
    );
    expect(ui.displayTitleForProposal(p, diff)).toBe('Move node');
    expect(ui.diffComparisonKey(diff)).not.toBe(ui.diffComparisonKey({ ...diff, moved: [] }));
  });

  it('closes details and clears selection with Close and Escape, retaining Show all changes', () => {
    const { ui, diffHost, rows, viewport, click } = mount({ func: 'return null;' });
    ui.setHash('#/proposals/p');
    click('[data-visual-node]', 'move');
    expect(rows.innerHTML).toContain('modified selected');
    expect(viewport.innerHTML).toContain('selection-glow');
    diffHost.onclick({
      target: { closest: (selector: string) => (selector === '.drawer-close' ? {} : null) },
    });
    expect(diffHost.innerHTML).toContain('Click a highlighted node to review its changes');
    expect(diffHost.innerHTML).toContain('Show all changes');
    expect(rows.innerHTML).not.toContain('modified selected');
    expect(viewport.innerHTML).not.toContain('selection-glow');
    click('[data-visual-node]', 'move');
    const preventDefault = vi.fn();
    ui.visualDetailsEscape({ key: 'Escape', preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(diffHost.innerHTML).toContain('Click a highlighted node to review its changes');
    expect(viewport.innerHTML).not.toContain('selection-glow');
  });

  it('switches an open diff to Unified below 700px and restores the desktop preference', () => {
    const { ui, diffHost, click, resize } = mount({ func: 'return null;' });
    ui.setViewport(1000);
    click('[data-visual-node]', 'move');
    expect(diffHost.innerHTML).toContain('class="shareddiff"');
    ui.setViewport(375);
    resize();
    expect(diffHost.innerHTML).toContain('class="unified"');
    expect(diffHost.innerHTML).not.toContain('class="shareddiff"');
    ui.setViewport(1000);
    resize();
    expect(diffHost.innerHTML).toContain('class="shareddiff"');
  });

  it('keeps node details open when Escape belongs to an open dialog or menu', () => {
    const { ui, diffHost, viewport, click } = mount({}, false, false, true);
    ui.setHash('#/proposals/p');
    click('[data-visual-node]', 'move');
    const preventDefault = vi.fn();
    ui.visualDetailsEscape({ key: 'Escape', preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(diffHost.innerHTML).toContain('MOVED NODE');
    expect(viewport.innerHTML).toContain('selection-glow');
  });

  it('gives conflicts precedence over property edits on the canvas and Changed-nodes list', () => {
    const { ui, p, diff, rows, viewport } = mount({ func: 'AI code' });
    const conflicting = {
      ...diff,
      rebase: { state: 'conflict', conflicts: [{ nodeId: 'move', fields: ['func'] }] },
    };
    ui.mountProposalVisual(p, conflicting);
    expect(ui.visualGraph(p, conflicting).byId.move.kind).toBe('conflict');
    expect(rows.innerHTML).toContain('class="visual-change-row conflict');
    expect(rows.innerHTML).toContain('data-icon="conflict"');
    expect(viewport.innerHTML).toContain('data-icon="conflict"');
    expect(viewport.innerHTML).not.toContain('data-icon="modified"');
  });

  it.each([false, true])(
    'keeps the editor ghost and SVG badge for a move with a property edit: %s',
    property => {
      const { rows, viewport, diffHost, click, ui, p, diff } = mount(
        property ? { func: 'return null;' } : {},
        true
      );
      click('[data-visual-layout]', 'editor');
      const kind = 'conflict';
      expect(ui.visualGraph(p, diff).byId.move).toMatchObject({ kind, moved: true });
      expect(viewport.innerHTML).toContain('move-ghost');
      expect(viewport.innerHTML).toContain('stroke-dasharray="8,3" fill-opacity=".6"');
      expect(viewport.innerHTML).toMatch(
        new RegExp('<circle[^>]*fill="' + '#dc9419' + '"/><svg[^>]*data-icon="' + kind + '"')
      );
      expect(viewport.innerHTML).toContain('color="#fff"');
      expect(rows.innerHTML).toContain('data-icon="resolved"');
      expect(rows.innerHTML).toContain('data-icon="editor-merged"');
      expect(rows.innerHTML).toContain('title="Also changed in the editor"');
      click('[data-visual-node]', 'move');
      if (property) {
        expect(diff.modified[0]?.changes.map(ch => ch.key)).toEqual(['func', 'x', 'y']);
        expect(diffHost.innerHTML).toContain('CONFLICT / FUNCTION');
        expect(diffHost.innerHTML).not.toContain('Modified nodes');
        expect(diffHost.innerHTML).toContain('Resolution selected.');
        expect(diffHost.innerHTML).not.toContain('Moved nodes');
      } else expect(diffHost.innerHTML).not.toContain('prop-change');
    }
  );
});

describe('shared status SVGs', () => {
  it('uses one currentColor set in compact chips, legend and canvas badges', () => {
    const ui = browserHelpers(),
      { p, diff } = chain([4]);
    for (const kind of [
      'added',
      'removed',
      'modified',
      'moved',
      'conflict',
      'resolved',
      'editor-merged',
      'deploy-pending',
    ]) {
      const icon = ui.statusIcon(kind);
      expect(icon).toContain('data-icon="' + kind + '"');
      expect(icon).toContain('stroke="currentColor"');
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).not.toMatch(/<text|[✎⚠✓•✥]/);
    }
    const chips = ui.renderChangeCounts({
      added: 1,
      removed: 2,
      modified: 3,
      moved: 4,
      conflict: 5,
    });
    expect(chips.match(/<svg /g)).toHaveLength(5);
    expect(chips).toContain('title="4 moved"');
    expect(chips).toContain('</svg><span aria-hidden="true">4</span>');
    for (const [kind, count] of Object.entries({
      added: 1,
      removed: 2,
      modified: 3,
      moved: 4,
      conflict: 5,
    }))
      expect(chips).toContain('<span class="visually-hidden">' + count + ' ' + kind + '</span>');
    const markup = ui.visualMarkup(p, diff);
    for (const kind of ['added', 'removed', 'modified', 'moved', 'conflict', 'editor-merged']) {
      expect(markup).toContain('data-icon="' + kind + '"');
    }
  });

  it.each(['unknown', '', undefined, null, 'toString', '__proto__'])(
    'uses an empty SVG body for unknown or missing status %s',
    kind => {
      const icon = browserHelpers().statusIcon(kind);
      expect(icon).toMatch(/><\/svg>$/);
      expect(icon).not.toMatch(/undefined|null|\[object|function/);
    }
  );

  it('gives the 12px Moved SVG a thin cross and four separate triangular arrowheads', () => {
    const icon = browserHelpers().statusIcon('moved', { size: 12 });
    expect(icon).toMatch(/^<svg[^>]*viewBox="0 0 24 24" width="12" height="12"/);
    expect(icon).toContain('stroke-linecap="round" stroke-linejoin="round"');
    expect(icon).toContain('<path d="M12 6v12M6 12h12" stroke-width="2"/>');
    expect(icon).toContain('<g fill="currentColor" stroke="none">');
    expect(icon.match(/<path d="M\d+ \d+L\d+ \d+[hv]\d+z"\/>/g)).toHaveLength(4);
    for (const head of ['M12 1L8 6h8z', 'M23 12L18 8v8z', 'M12 23L8 18h8z', 'M1 12L6 8v8z']) {
      expect(icon).toContain('d="' + head + '"');
    }
    expect(icon).not.toContain('<circle');
  });
});

describe('Visual View node drawer', () => {
  const lines = [
    { op: 'add', text: 'const first = true;' },
    { op: 'equal', text: 'msg.payload = {' },
    { op: 'remove', text: '  old: "short",' },
    { op: 'add', text: '  next: "' + 'a long wrapped value '.repeat(30) + '",' },
    { op: 'add', text: '  source: "ai-access",' },
    { op: 'equal', text: '};' },
    { op: 'remove', text: 'obsolete();' },
  ];
  const change = { key: 'func', kind: 'text', lines };
  const node = { id: 'n<script>', type: 'function', name: 'Build <reply>', kind: 'modified' };
  const diff = { summary: { modified: 1 }, modified: [{ ...node, changes: [change] }] };

  it('renders identity, close control, and the mode toggle inside the field summary', () => {
    const ui = browserHelpers({}, [], () => ({ matches: true }));
    const html = ui.renderVisualNodeDrawer(node, { id: 'p' }, diff);
    expect(html).toContain('<div class="visual-eyebrow">MODIFIED NODE</div>');
    expect(html).toContain('<h2>Build &lt;reply&gt;</h2>');
    expect(html).toContain('function · n&lt;script&gt;');
    expect(html).toContain('aria-label="Close details">×</button>');
    expect(html).toMatch(
      /class="fieldsummary"><span>Field <code>func<\/code> · 3 added lines<\/span><div class="diff-mode-toggle diffmodes"/
    );
    expect(html).toContain('data-diff-mode="split" aria-pressed="true"');
    expect(html).not.toMatch(/Proposed change|Modified nodes|diff-toolbar/);
    expect(html).toContain('Show in editor');
  });

  it('puts both cells in one row for additions, removals and unequal wrapped replacements', () => {
    const ui = browserHelpers();
    const html = ui.renderPropertyChange(change, 'split');
    expect(html).toContain('<div class="diffhead">BEFORE</div>');
    expect(html).toContain('<div class="diffhead">AFTER (PROPOSED)</div>');
    expect(html.match(/class="shareddiff"/g)).toHaveLength(1);
    const rows = html.match(/<div class="diffrow">.*?<\/div><\/div>/g)!;
    expect(rows).toHaveLength(6);
    expect(rows[0]).toContain(
      'class="diffcol line filler"><i></i><b> </b><span></span></div><div class="diffcol line ins"><i>1</i><b>+</b>'
    );
    expect(rows[1]).toContain('class="diffcol line equal"><i>1</i><b> </b>');
    expect(rows[2]).toContain('class="diffcol line del"><i>2</i><b>-</b>');
    expect(rows[2]).toContain('class="diffcol line ins"><i>3</i><b>+</b>');
    expect(rows[2]).toContain('a long wrapped value '.repeat(30));
    expect(rows[3]).toContain(
      'class="diffcol line filler"><i></i><b> </b><span></span></div><div class="diffcol line ins"><i>4</i><b>+</b>'
    );
    expect(rows[5]).toContain('class="diffcol line del"><i>4</i><b>-</b>');
    expect(rows[5]).toContain('class="diffcol line filler"><i></i><b> </b><span></span></div>');
    for (const row of rows) {
      expect(row.match(/<i>\d*<\/i><b>[-+ ]<\/b><span>/g)).toHaveLength(2);
    }
    expect(html.match(/class="diffscroll"/g)).toHaveLength(1);
    expect(html).not.toContain('diff-pane');
  });

  it('renders Unified with old/new line numbers, signs and uppercase pane headers', () => {
    const ui = browserHelpers();
    const html = ui.renderPropertyChange(change, 'unified');
    expect(html).toContain('<div class="diffhead">BEFORE → AFTER (PROPOSED)</div>');
    expect(html).toContain('<div class="unifiedline ins"><i></i><i>1</i><b>+</b>');
    expect(html).toContain('<div class="unifiedline equal"><i>1</i><i>2</i><b> </b>');
    expect(html).toContain('<div class="unifiedline del"><i>2</i><i></i><b>-</b>');
    expect(html).toContain('<div class="unifiedline equal"><i>3</i><i>5</i><b> </b>');
  });

  it.each(['split', 'unified'])('isolates short/scalar properties from line panes in %s', mode => {
    const ui = browserHelpers();
    const before = { id: 'n', type: 'inject', name: 'Old', topic: 'a', repeat: 1, once: false };
    const after = { ...before, name: 'New', topic: 'b', repeat: 2, once: true };
    const changes = buildDiffSections({ nodes: [after] }, { nodes: [before] }).modified[0]!.changes;
    expect(changes).toHaveLength(4);
    for (const ch of changes) {
      expect(ch.kind).toBe('scalar');
      const html = ui.renderPropertyChange(ch, mode);
      expect(html).not.toMatch(/shareddiff|unified|diffhead|diffscroll|fieldsummary|diffmodes/);
      expect(html).toContain(
        '<code class="diff-before" title="before">' +
          JSON.stringify(ch.before).replace(/"/g, '&quot;') +
          '</code>'
      );
      expect(html).toContain(
        '<code class="diff-after" title="after">' +
          JSON.stringify(ch.after).replace(/"/g, '&quot;') +
          '</code>'
      );
      if (mode === 'split') {
        expect(html).toContain('class="prop-change-scalar split"');
        expect(html).toContain('<span class="side-label">Before</span>');
        expect(html).toContain('<span class="side-label">After</span>');
      } else expect(html).toContain('</code> → <code class="diff-after"');
    }
  });

  it.each(['split', 'unified'])(
    'keeps short text changes compact in %s, including summaries',
    mode => {
      const ui = browserHelpers();
      for (const key of ['format', 'syntax', 'info', 'payload', 'text']) {
        const before = 'x'.repeat(PRESENCE_SHORT_TEXT_MAX);
        const after = '<new>';
        const sections = buildDiffSections(
          { nodes: [{ id: 'n', type: 'template', [key]: after }] },
          { nodes: [{ id: 'n', type: 'template', [key]: before }] }
        );
        expect(sections.modified[0]!.changes[0]!.kind).toBe('text');
        for (const format of ['full', 'summary'] as const) {
          const formatted = applyDiffFormat(
            {
              ...sections,
              proposalId: 'p',
              flowId: 'tab',
              expectedRev: 'r1',
              baseRev: 'r1',
              currentRev: 'r1',
              baseRevChanged: false,
              compareAgainst: 'base',
            },
            format
          );
          const html = ui.renderPropertyChange(formatted.modified[0]!.changes[0], mode);
          expect(html).not.toMatch(
            /shareddiff|unified|diffhead|diffscroll|fieldsummary|diffmodes|data-diff-mode/
          );
          expect(html).not.toMatch(/BEFORE|AFTER \(PROPOSED\)|LIVE \(IN EDITOR\)|AI PROPOSED/);
          expect(html).toContain('&quot;' + before + '&quot;');
          expect(html).toContain('&quot;&lt;new&gt;&quot;');
          if (mode === 'split') expect(html).toContain('class="prop-change-scalar split"');
          else expect(html).toContain('</code> → <code class="diff-after"');
        }
      }
    }
  );

  it.each(['split', 'unified'])('uses panes for code and either long text value in %s', mode => {
    const ui = browserHelpers();
    const long = 'x'.repeat(PRESENCE_SHORT_TEXT_MAX + 1);
    const cases: [string, string, string][] = [
      ['func', 'old', 'new'],
      ['template', 'old', 'new'],
      ['code', 'old', 'new'],
      ['format', long, 'new'],
      ['syntax', 'old', long],
      ['custom', 'old\nline', 'new'],
      ['custom', 'old', 'new\nline'],
    ];
    for (const [key, before, after] of cases) {
      const sections = buildDiffSections(
        { nodes: [{ id: 'n', type: 'function', [key]: after }] },
        { nodes: [{ id: 'n', type: 'function', [key]: before }] }
      );
      const ch = sections.modified[0]!.changes[0]!;
      expect(ch.kind).toBe('text');
      const html = ui.renderPropertyChange(ch, mode);
      expect(html).toContain(mode === 'split' ? 'class="shareddiff"' : 'class="unified"');
      expect(html).toContain(
        mode === 'split' ? '>BEFORE</div>' : '>BEFORE → AFTER (PROPOSED)</div>'
      );
      expect(html).toContain('<b>-</b>');
      expect(html).toContain('<b>+</b>');
    }
  });

  it.each(['split', 'unified'])('keeps short conflicts in the existing markup in %s', mode => {
    const ui = browserHelpers();
    ui.setPermission(true);
    ui.setDiffMode(mode);
    const cases: [string, unknown, unknown][] = [
      ['name', 'Old', '<New>'],
      ['topic', 'a', 'b'],
      ['format', 'text', 'html'],
      ['syntax', 'plain', 'mustache'],
      ['repeat', 1, 2],
      ['once', false, true],
      ['custom', 'x'.repeat(PRESENCE_SHORT_TEXT_MAX), 'new'],
      ['wires', [['a']], [['b']]],
    ];
    for (const [field, live, proposed] of cases) {
      const rebase = {
        state: 'conflict',
        conflicts: [
          {
            nodeId: node.id,
            fields: [field],
            kind: 'node_changed_both',
            choices: ['live', 'proposed'],
          },
        ],
      };
      // Also defend against old/cached payloads containing lines for short fields.
      for (const withLines of [false, true]) {
        const html = ui.renderVisualNodeDrawer(
          { ...node, kind: 'conflict' },
          { id: 'p', rebase },
          {
            rebase,
            conflictValues: [
              {
                nodeId: node.id,
                fields: [
                  {
                    field,
                    live,
                    proposed,
                    ...(withLines
                      ? { lines: diffLines(JSON.stringify(live), JSON.stringify(proposed)) }
                      : {}),
                  },
                ],
              },
            ],
          }
        );
        expect(html).not.toMatch(
          /shareddiff|unified|diffhead|diffscroll|diffmodes|data-conflict-diff-mode/
        );
        expect(html).not.toMatch(/LIVE \(IN EDITOR\)|AI PROPOSED/);
        expect(html).toContain('<dt>Editor (live)</dt>');
        expect(html).toContain('<dt>AI proposed</dt>');
        expect(html).toContain('>Keep live</button>');
        expect(html).toContain('>Use AI proposed</button>');
        if (field === 'name') expect(html).toContain('&lt;New&gt;');
      }
    }
  });

  it('uses one pane border, a continuous divider, sticky headers and plain fillers', () => {
    const css = pageStyles();
    expect(css).toMatch(/\.shareddiff, \.unified\s*\{[^}]*border: 1px solid var\(--line\)/);
    expect(css).toMatch(/\.diffrow\s*\{[^}]*gap: 0;/);
    expect(css).toMatch(/\.shareddiff \.diffrow > :last-child\s*\{[^}]*border-left: 1px solid/);
    expect(css).toMatch(/\.diffheaders\s*\{[^}]*position: sticky; top: 0;/);
    expect(css).toMatch(/\.shareddiff \.diffcol\s*\{[^}]*min-height: 24px;/);
    expect(css).toContain('.shareddiff .filler { background: #f0f3f6; }');
    expect(css).not.toContain('repeating-linear-gradient');
    expect(css).toMatch(/\.line\.del, \.unifiedline\.del\s*\{[^}]*background: #fdeceb;/);
    expect(css).toMatch(/\.line\.ins, \.unifiedline\.ins\s*\{[^}]*background: #e6f6ec;/);
    expect(css).toMatch(
      /\.shareddiff \.line\.chosen-line, \.unifiedline\.chosen-line\s*\{[^}]*font-weight: 700;/
    );
    expect(css).toMatch(/\.shareddiff\[data-chosen="proposed"\][^{]*\{[^}]*opacity: \.4;/);
  });

  it.each(['split', 'unified'])('keeps large-diff collapse and omitted context in %s', mode => {
    const ui = browserHelpers();
    const html = ui.renderPropertyChange(
      {
        ...change,
        beforeBytes: 20000,
        lines: [{ op: 'equal', text: '… (50 unchanged lines) …' }, ...lines],
      },
      mode
    );
    expect(html).toContain(
      '<details class="large-diff-details"><summary class="large-diff-btn">Show 8-line change</summary>'
    );
    expect(html.split('(50 unchanged lines)')).toHaveLength(mode === 'split' ? 3 : 2);
    if (mode === 'split')
      expect(html).toContain(
        '<div class="diffrow"><div class="diffcol line equal"><i>1</i><b> </b><span>… (50 unchanged lines) …</span></div><div class="diffcol line equal"><i>1</i>'
      );
  });

  it('uses Split from 700px and remembers a preference while forcing Unified below 700px', () => {
    const ui = browserHelpers();
    ui.setViewport(700);
    expect(ui.getDiffMode()).toBe('split');
    ui.setDiffMode('unified');
    expect(ui.getDiffMode()).toBe('unified');
    ui.setDiffMode('split');
    ui.setViewport(375);
    expect(ui.getDiffMode()).toBe('unified');
    ui.setViewport(1000);
    expect(ui.getDiffMode()).toBe('split');
  });

  it('uses mockup conflict chrome and immediate choice controls without Re-check', () => {
    const ui = browserHelpers({}, [], () => ({ matches: true }));
    ui.setPermission(true);
    const rebase = {
      state: 'conflict',
      conflicts: [
        {
          nodeId: node.id,
          fields: ['func'],
          kind: 'node_changed_both',
          choices: ['live', 'proposed'],
        },
      ],
    };
    const html = ui.renderVisualNodeDrawer(
      { ...node, kind: 'conflict' },
      { id: 'p', rebase },
      { ...diff, rebase, conflictValues: [{ nodeId: node.id, fields: [{ field: 'func', lines }] }] }
    );
    expect(html).toContain('CONFLICT / FUNC');
    expect(html).toContain('class="drawer-notice"');
    expect(html).toContain('<div class="diffhead">LIVE (IN EDITOR)</div>');
    expect(html).toContain('<div class="diffhead">AI PROPOSED</div>');
    expect(html).toMatch(
      /class="chooserow">.*data-choice="live" aria-pressed="false">Keep live<.*data-choice="proposed" aria-pressed="false">Use AI proposed</
    );
    expect(html).not.toContain('recheck-btn');
    expect(html).not.toMatch(/Other field changes|class="hint"/);
    expect(html).toContain(
      'This node was also edited in the editor. Field <code>func</code> changed on both sides.'
    );
    expect(html).not.toContain('proposal-conflicts');
  });

  it.each([
    ['split', 'live'],
    ['split', 'proposed'],
    ['unified', 'live'],
    ['unified', 'proposed'],
  ])('renders the chosen button and changed/rejected line styles in %s for %s', (mode, choice) => {
    const ui = browserHelpers();
    ui.setPermission(true);
    ui.setDiffMode(mode);
    const html = ui.renderVisualNodeDrawer(
      { ...node, kind: 'conflict' },
      {
        id: 'p',
        status: 'pending',
        conflictChoices: [{ nodeId: node.id, fields: ['func', 'name<unsafe>'], choice }],
        rebase: { state: 'merged', conflicts: [] },
      },
      {
        ...diff,
        rebase: { state: 'merged', conflicts: [] },
        conflictValues: [{ nodeId: node.id, fields: [{ field: 'func', lines }] }],
      }
    );
    const selected = choice === 'proposed' ? 'ins' : 'del';
    const rejected = choice === 'proposed' ? 'del' : 'ins';
    expect(html).toContain(
      mode === 'split'
        ? '<div class="diffhead">LIVE (IN EDITOR)</div><div class="diffhead">AI PROPOSED</div>'
        : '<div class="diffhead">LIVE (IN EDITOR) → AI PROPOSED</div>'
    );
    expect(html).toContain(selected + ' chosen-line');
    expect(html).toContain('<b>-</b>');
    expect(html).toContain('<b>+</b>');
    expect(html).toContain('class="conflict-values" data-chosen="' + choice + '"');
    if (mode === 'split') expect(html).toContain('class="shareddiff" data-chosen="' + choice + '"');
    else expect(html).toContain(rejected + ' rejected');
    expect(html).toContain('resolve-conflict-btn chosen');
    expect(html).toContain(
      'data-choice="' +
        choice +
        '" aria-pressed="true">' +
        (choice === 'live' ? '✓ Keeping live' : '✓ Using AI proposed') +
        '</button>'
    );
    expect(html).toContain(
      'data-choice="' +
        (choice === 'live' ? 'proposed' : 'live') +
        '" aria-pressed="false">' +
        (choice === 'live' ? 'Use AI proposed' : 'Keep live') +
        '</button>'
    );
    expect(html).toContain('Resolution selected.');
    expect(html).toContain(
      'Fields <code>func</code>, <code>name&lt;unsafe&gt;</code> changed on both sides.'
    );
    expect(html).not.toMatch(/recheck-btn|Undo \/|preview only/);
  });

  it('blocks Approve until the last conflict is resolved on a pending proposal', () => {
    const ui = browserHelpers();
    ui.setPermission(true);
    const p = {
      id: 'p',
      status: 'pending',
      rebase: { state: 'conflict', conflicts: [{ nodeId: 'one' }, { nodeId: 'two' }] },
    };
    const d = { ...diff, rebase: p.rebase };
    for (const conflicts of [[{ nodeId: 'one' }, { nodeId: 'two' }], [{ nodeId: 'two' }]]) {
      p.rebase.conflicts = conflicts;
      ui.setDiff(p, d);
      expect(ui.renderReviewActionRow(p, false)).toMatch(/class="action approve-btn"[^>]*disabled/);
    }
    p.rebase = { state: 'merged', conflicts: [] };
    d.rebase = p.rebase;
    ui.setDiff(p, d);
    expect(ui.renderReviewActionRow(p, false)).not.toMatch(
      /class="action approve-btn"[^>]*disabled/
    );
  });

  it('keeps saved conflict values and chosen styling after the API returns an empty conflict list', () => {
    const ui = browserHelpers({}, [], () => ({ matches: true }));
    ui.setConflictValues('p', [{ nodeId: node.id, fields: [{ field: 'func', lines }] }]);
    const html = ui.renderVisualNodeDrawer(
      node,
      {
        id: 'p',
        conflictChoice: { nodeId: node.id, choice: 'proposed' },
        rebase: { state: 'merged' },
      },
      { ...diff, conflictValues: [] }
    );
    expect(html).toContain('CONFLICT / FUNC');
    expect(html).toContain('data-chosen="proposed"');
    expect(html).toContain('<div class="diffhead">AI PROPOSED</div>');
    expect(html).not.toContain('AFTER (PROPOSED)');
  });

  it.each(['added', 'removed', 'moved'])('uses the same drawer chrome for %s nodes', kind => {
    const ui = browserHelpers();
    const entry = {
      ...node,
      before: { x: 1, y: 2 },
      after: { x: 3, y: 4 },
      properties: [{ key: 'name', value: 'a name' }],
    };
    const html = ui.renderVisualNodeDrawer(
      { ...node, kind },
      { id: 'p' },
      { summary: {}, [kind]: [entry] }
    );
    expect(html).toContain(kind.toUpperCase() + ' NODE');
    expect(html).toContain('aria-label="Close details"');
    expect(html).toContain('function · n&lt;script&gt;');
    if (kind === 'moved') expect(html).toContain('(1, 2) → (3, 4)');
    else expect(html).toContain('This node will be ' + (kind === 'added' ? 'added.' : 'deleted.'));
  });
});
