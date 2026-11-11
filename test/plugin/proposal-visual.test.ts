import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { pageClientVisualGeometryScript } from '../../src/plugin/page-client-visual.js';
import { pageClientScript } from '../../src/plugin/page-client.js';
import { flowChangeCounts, proposalChangeCounts } from '../../src/plugin/proposal-changes.js';
import { buildDiffSections } from '../../src/plugin/proposal-diff.js';
import { presentProposalForApi } from '../../src/plugin/proposal-present.js';
import type { Proposal } from '../../src/storage/proposals.js';

function browserHelpers() {
  const context = {
    document: {
      getElementById: (id: string) =>
        id === 'mcp-root'
          ? { getAttribute: () => '{}' }
          : {
              addEventListener: vi.fn(),
              setAttribute: vi.fn(),
              querySelectorAll: () => [],
              getAttribute: () => null,
            },
      querySelectorAll: () => [],
      addEventListener: vi.fn(),
    },
    window: { addEventListener: vi.fn() },
    location: { hash: '#proposals' },
  };
  return runInNewContext(
    pageClientScript().replace(
      '  boot();',
      `
    globalThis.ui = {
      visualGraph, visualVisible, visualToggleRun, visualNodeSvg, renderCompactProposal,
      proposalMatchesFilter, renderChangeCounts, renderReviewActionRow, approveProposal,
      settleSearchAfterAction,
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
      /data-visual-node|tabindex|role="button"|change-outline|font-style="italic"/
    );
  });
});

describe('proposal summaries and deploy controls', () => {
  it('shares counts between API, list and detail, including moved, rewired, config and conflict nodes', () => {
    const before = {
      nodes: [
        { id: 'move', type: 'function', x: 1 },
        { id: 'wire', type: 'inject', wires: [[]] },
        { id: 'remove', type: 'debug' },
      ],
      configs: [{ id: 'config', type: 'mqtt-broker', port: 1883 }],
    };
    const after = {
      nodes: [
        { id: 'move', type: 'function', x: 2 },
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
    expect(counts).toEqual({ added: 1, removed: 1, modified: 3, conflict: 1 });
    expect(counts).toMatchObject({
      added: summary.added,
      removed: summary.removed,
      modified: summary.modified,
    });
    expect(presentProposalForApi(p).changeCounts).toEqual(counts);
    expect(
      proposalChangeCounts({ ...p, status: 'pending', rebase: { ...p.rebase!, state: 'merged' } })
        .conflict
    ).toBe(0);
    const ui = browserHelpers();
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
      changeCounts: { added: 2, removed: 1, modified: 3, conflict: 1 },
    };
    const html = ui.renderCompactProposal(p);
    expect(html).toMatch(/<strong[^>]*>[^<]*<\/strong><span class="proposal-inline-warning"/);
    expect(html).toContain('title="Deploy pending"');
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
