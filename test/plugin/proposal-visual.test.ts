import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { pageClientVisualGeometryScript } from '../../src/plugin/page-client-visual.js';
import { pageClientScript } from '../../src/plugin/page-client.js';
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
  matchMedia?: (query: string) => { matches: boolean }
) {
  const context = {
    document: {
      getElementById: (id: string) =>
        id === 'mcp-root'
          ? { getAttribute: () => '{}' }
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
    window: { addEventListener: vi.fn(), matchMedia },
    location: { hash: '#proposals' },
  };
  return runInNewContext(
    pageClientScript().replace(
      '  boot();',
      `
    globalThis.ui = {
      visualGraph, visualVisible, visualToggleRun, visualNodeSvg, visualMarkup, renderCompactProposal,
      mountProposalVisual, statusIcon, renderHumanDiff, displayTitleForProposal, diffComparisonKey,
      proposalMatchesFilter, renderChangeCounts, renderReviewActionRow, approveProposal,
      settleSearchAfterAction, bindReviewControls, proposalForReview, doApproveProposal, rejectProposal,
      renderProposalsList, renderDecidedLoadMore, bindCrossTabHint, countSearchMatchesInFilter,
      setSearch: function (filter, query, proposals, more) { proposalsFilter = filter; proposalsSearchQuery = query; cachedProposals = proposals; decidedHasMore = more; },
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

describe('Visual View geometry', () => {
  const moveGeometry = runInNewContext(pageClientVisualGeometryScript() + '\nvisualMoveGeometry;');

  it.each([
    { next: { x: 200, y: 120 }, start: { x: 25, y: 15 }, end: { x: 175, y: 105 } },
    { next: { x: 400, y: 0 }, start: { x: 50, y: 0 }, end: { x: 350, y: 0 } },
    { next: { x: 0, y: 60 }, start: { x: 0, y: 15 }, end: { x: 0, y: 45 } },
    { next: { x: -200, y: -120 }, start: { x: -25, y: -15 }, end: { x: -175, y: -105 } },
    { next: { x: -400, y: 0 }, start: { x: -50, y: 0 }, end: { x: -350, y: 0 } },
    { next: { x: 0, y: -60 }, start: { x: 0, y: -15 }, end: { x: 0, y: -45 } },
  ])('clips a centre-line move to rectangle edges: $next', ({ next, start, end }) => {
    const old = { x: 0, y: 0 };
    const arrow = moveGeometry(old, next, 100, 30);
    expect(arrow.start).toEqual(start);
    expect(arrow.end).toEqual(end);
    for (const [point, centre] of [
      [arrow.start, old],
      [arrow.end, next],
    ]) {
      const dx = Math.abs(point.x - centre.x),
        dy = Math.abs(point.y - centre.y);
      expect(dx).toBeLessThanOrEqual(50);
      expect(dy).toBeLessThanOrEqual(15);
      expect(dx === 50 || dy === 15).toBe(true);
      expect((point.x - centre.x) * next.y - (point.y - centre.y) * next.x).toBeCloseTo(0);
    }
    expect(arrow.gap).toBeCloseTo(Math.hypot(end.x - start.x, end.y - start.y));
    expect(Math.hypot(end.x - arrow.shaftEnd.x, end.y - arrow.shaftEnd.y)).toBeCloseTo(12);
    expect(arrow.shaftEnd.x).toBeCloseTo(end.x - (next.x / Math.hypot(next.x, next.y)) * 12);
    expect(arrow.shaftEnd.y).toBeCloseTo(end.y - (next.y / Math.hypot(next.x, next.y)) * 12);
    expect((arrow.headLeft.x + arrow.headRight.x) / 2).toBeCloseTo(arrow.shaftEnd.x);
    expect((arrow.headLeft.y + arrow.headRight.y) / 2).toBeCloseTo(arrow.shaftEnd.y);
    expect(
      Math.hypot(arrow.headLeft.x - arrow.headRight.x, arrow.headLeft.y - arrow.headRight.y)
    ).toBeCloseTo(12);
  });

  it.each([
    { x: 0, y: 0 },
    { x: 90, y: 20 },
    { x: 100, y: 30 },
    { x: 115, y: 0 },
    { x: 0, y: 45 },
    { x: -115, y: 0 },
  ])('hides overlapping, touching or tiny-gap moves: %j', next => {
    expect(moveGeometry({ x: 0, y: 0 }, next, 100, 30)).toBeNull();
  });

  it('shows an arrow at the minimum readable edge gap, independent of centre distance', () => {
    expect(moveGeometry({ x: 0, y: 0 }, { x: 116, y: 0 }, 100, 30).gap).toBeCloseTo(16);
    expect(moveGeometry({ x: 0, y: 0 }, { x: 0, y: 46 }, 100, 30).gap).toBeCloseTo(16);
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

  it.each([200000, 1, 2, -1, NaN, Infinity, -Infinity])(
    'bounds rendered outputs for %s',
    outputs => {
      const ui = browserHelpers();
      const p = { payload: { flow: { nodes: [{ id: 'n', type: 'inject', outputs }] } } };
      const n = ui.visualGraph(p, {}).byId.n;
      const visible = Number.isFinite(outputs) && outputs > 0 ? Math.min(32, outputs) : 0;
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
    expect(html).toContain('Created by agent');
    expect(html).toContain('Main');
    expect(html).toContain('Rebase: clean');
    expect(html).not.toMatch(/approve-btn|reject-btn|Approve|Reject|proposal-detail|<button/);
    expect(ui.renderCompactProposal({ ...p, status: 'approved' })).not.toContain('rebase-chip');
    for (const status of ['approved', 'rejected', 'failed', 'withdrawn', 'expired', 'superseded'])
      expect(ui.proposalMatchesFilter({ status }, 'resolved')).toBe(true);
    expect(ui.proposalMatchesFilter({ status: 'conflict' }, 'pending')).toBe(false);
    expect(ui.proposalMatchesFilter({ status: 'conflict' }, 'conflict')).toBe(true);
    expect(ui.proposalMatchesFilter({ status: 'pending' }, 'pending')).toBe(true);
    expect(ui.proposalMatchesFilter({ status: 'pending' }, 'all')).toBe(true);
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
      expect(html).not.toMatch(/class="action approve-btn"[^>]*disabled/);
      const approve = vi.fn();
      ui.setApprove(approve);
      ui.setDeploy('p', 'flows');
      expect(approve).not.toHaveBeenCalled();
      await ui.approveProposal('p');
      expect(approve).toHaveBeenCalledWith('p', 'flows');
      for (const blocked of [
        { ...p, status: 'conflict' },
        { ...p, status: 'approved' },
      ]) {
        const blockedHtml = ui.renderReviewActionRow(blocked, blocked.status === 'conflict');
        expect(blockedHtml).toMatch(/class="action approve-btn"[^>]*disabled/);
        expect(blockedHtml).toMatch(/class="approve-options"[^>]*disabled/);
      }
      ui.setPermission(false);
      expect(ui.renderReviewActionRow(p, false)).toMatch(/class="approve-options"[^>]*disabled/);
    }
  );
});

describe('proposal search pagination and cross-filter hints', () => {
  function searchUi() {
    const list = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
    const ui = browserHelpers({ 'proposals-list': list });
    return { ui, list };
  }

  it.each([1, 2])('marks %i loaded Resolved matches as partial until pagination ends', count => {
    const { ui, list } = searchUi();
    const proposals = [
      { id: 'c', title: 'needle', status: 'conflict' },
      ...Array.from({ length: count }, (_, i) => ({
        id: 'r' + i,
        title: 'needle',
        status: 'approved',
      })),
    ];
    ui.setSearch('pending', 'needle', proposals, true);
    ui.renderProposalsList();
    expect(list.innerHTML).toContain(count + '+ matches in Resolved');
    expect(list.innerHTML).toContain('1 match in Conflict');
    ui.setSearch('pending', 'needle', proposals, false);
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
      ['pending', 'Pending', 1],
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
        filter === 'pending' ? 'conflict' : 'pending',
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
      querySelector: () => ({ focus: vi.fn() }),
    };
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
    expect(actions.innerHTML).toMatch(/class="action approve-btn"[^>]*disabled/);
    expect(actions.innerHTML).toMatch(/class="approve-options"[^>]*disabled/);
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

  function mount(patch: Record<string, unknown> = {}, resolved = false, additionalMove = false) {
    const extra = additionalMove ? [{ ...original, id: 'second', y: 400 }] : [];
    const p = {
      id: 'p',
      title: 'Update flow',
      status: 'pending',
      baseFlow: { nodes: [original, ...extra] },
      visualLiveFlow: { nodes: [{ ...original, func: 'editor change' }] },
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
    const svg = { addEventListener: vi.fn() };
    const showAll = { onclick: null as null | (() => void) };
    const diffHost = {
      innerHTML: '',
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
    const ui = browserHelpers({ '[data-visual-for="p"]': host, '[data-diff-for="p"]': diffHost });
    ui.setApi(() => Promise.resolve({}));
    ui.mountProposalVisual(p, diff);
    const click = (selector: string, attr: string) =>
      host.onclick({
        detail: 0,
        target: {
          closest: (query: string) => (query === selector ? { getAttribute: () => attr } : null),
        },
      });
    return { ui, p, diff, viewport, rows, diffHost, host, showAll, click };
  }

  it.each([
    { name: 'down-right', patch: { x: 300, y: 240 }, shown: true },
    { name: 'long horizontal', patch: { x: 600, y: 120 }, shown: true },
    { name: 'modest vertical', patch: { x: 100, y: 180 }, shown: true },
    { name: 'short overlapping', patch: { x: 120, y: 130 }, shown: false },
    { name: 'tiny edge gap', patch: { x: 100, y: 165 }, shown: false },
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
      expect(html.indexOf('class="move-arrow"')).toBeLessThan(html.indexOf('move-ghost'));
    }
  });

  it('paints every arrow before every ghost, then wires and live nodes', () => {
    const { viewport, click } = mount({ wires: [['second']] }, false, true);
    click('[data-visual-layout]', 'editor');
    const html = viewport.innerHTML;
    expect(html.match(/class="move-arrow"/g)).toHaveLength(2);
    expect(html.match(/move-ghost/g)).toHaveLength(2);
    expect(html.lastIndexOf('class="move-arrow"')).toBeLessThan(html.indexOf('move-ghost'));
    const wire = html.indexOf('stroke-width="3"');
    expect(html.lastIndexOf('move-ghost')).toBeLessThan(wire);
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
    showAll.onclick!();
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

  it.each([false, true])(
    'keeps the editor ghost and SVG badge for a move with a property edit: %s',
    property => {
      const { rows, viewport, diffHost, click, ui, p, diff } = mount(
        property ? { func: 'return null;' } : {},
        true
      );
      click('[data-visual-layout]', 'editor');
      const kind = property ? 'modified' : 'moved';
      expect(ui.visualGraph(p, diff).byId.move).toMatchObject({ kind, moved: true });
      expect(viewport.innerHTML).toContain('move-ghost');
      expect(viewport.innerHTML).toContain('stroke-dasharray="8,3" fill-opacity=".6"');
      expect(viewport.innerHTML).toMatch(
        new RegExp(
          '<circle[^>]*fill="' +
            (property ? '#2f6fed' : '#7a6fb0') +
            '"/><svg[^>]*data-icon="' +
            kind +
            '"'
        )
      );
      expect(viewport.innerHTML).toContain('color="#fff"');
      expect(rows.innerHTML).toContain('data-icon="resolved"');
      expect(rows.innerHTML).toContain('data-icon="editor-merged"');
      expect(rows.innerHTML).toContain('title="Also changed in the editor"');
      click('[data-visual-node]', 'move');
      if (property) {
        expect(diff.modified[0]?.changes.map(ch => ch.key)).toEqual(['func', 'x', 'y']);
        expect(diffHost.innerHTML).toContain('Modified nodes');
        expect(diffHost.innerHTML).toContain('prop-change');
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
