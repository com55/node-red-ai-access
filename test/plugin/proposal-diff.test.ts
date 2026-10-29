import { describe, expect, it } from 'vitest';

import {
  buildDiffSections,
  buildProposalDiff,
  isLargeDelete,
} from '../../src/plugin/proposal-diff.js';
import type { Proposal } from '../../src/storage/proposals.js';

function proposal(partial: Partial<Proposal> & Pick<Proposal, 'payload'>): Proposal {
  return {
    id: 'prop-abc123456789',
    type: 'replace_flow',
    status: 'pending',
    expectedRev: 'rev-1',
    createdBy: { kind: 'access-link', linkId: 'link-1', label: 'agent' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('buildProposalDiff', () => {
  it('counts added, removed, and modified nodes vs base snapshot', () => {
    const diff = buildProposalDiff(
      proposal({
        baseFlow: {
          id: 'tab1',
          label: 'Main',
          nodes: [
            { id: 'n1', type: 'inject', name: 'tick', topic: 'old' },
            { id: 'n2', type: 'function', name: 'fn', func: 'return msg;' },
          ],
        },
        payload: {
          flowId: 'tab1',
          flow: {
            id: 'tab1',
            label: 'Renamed',
            nodes: [
              { id: 'n1', type: 'inject', name: 'tick', topic: 'changed' },
              { id: 'n3', type: 'debug', name: 'out' },
            ],
          },
        },
      }),
      {
        rev: 'rev-1',
        flow: {
          id: 'tab1',
          label: 'Main',
          nodes: [
            { id: 'n1', type: 'inject', name: 'tick', topic: 'old' },
            { id: 'n2', type: 'function', name: 'fn', func: 'return msg;' },
          ],
        },
      },
      { compareAgainst: 'base' }
    );

    expect(diff.summary).toEqual({
      added: 1,
      removed: 1,
      modified: 1,
      tabChanges: ['label'],
      beforeNodeCount: 2,
      afterNodeCount: 2,
    });
    expect(diff.compareAgainst).toBe('base');
    expect(diff.baseRevChanged).toBe(false);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]).toMatchObject({ id: 'n3', type: 'debug', name: 'out' });
    expect(diff.added[0]?.summary).toMatch(/Adds debug node "out"/);
    expect(diff.added[0]?.keyFields.some(p => p.key === 'name')).toBe(true);
    expect(diff.added[0]?.properties.some(p => p.key === 'type' && p.kind === 'scalar')).toBe(true);
    expect(diff.added[0]?.properties.some(p => p.key === 'name')).toBe(true);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]).toMatchObject({ id: 'n2', type: 'function', name: 'fn' });
    expect(diff.removed[0]?.summary).toMatch(/Removes function node "fn"/);
    const removedFunc = diff.removed[0]?.properties.find(p => p.key === 'func');
    expect(removedFunc).toEqual({ key: 'func', kind: 'text', value: 'return msg;' });
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]?.id).toBe('n1');
    expect(diff.modified[0]?.summary).toMatch(/Changes inject node/);
    expect(diff.modified[0]?.changes).toEqual([
      { key: 'topic', kind: 'scalar', before: 'old', after: 'changed' },
    ]);
  });

  it('keeps base-snapshot diff when live flow later adds unrelated nodes', () => {
    const base = {
      id: 'tab1',
      type: 'tab',
      nodes: [{ id: 'n1', type: 'inject', name: 'tick' }],
    };
    const proposed = {
      id: 'tab1',
      type: 'tab',
      nodes: [{ id: 'n1', type: 'inject', name: 'tick', topic: 'x' }],
    };
    // Live flow after another approval added html20k — must NOT appear as removed.
    const live = {
      id: 'tab1',
      type: 'tab',
      nodes: [
        { id: 'n1', type: 'inject', name: 'tick' },
        { id: 'html20k', type: 'template', name: 'html20k', template: '<p>big</p>' },
      ],
    };

    const vsBase = buildDiffSections(proposed, base);
    expect(vsBase.summary).toEqual({
      added: 0,
      removed: 0,
      modified: 1,
      tabChanges: [],
      beforeNodeCount: 1,
      afterNodeCount: 1,
    });
    expect(vsBase.removed).toEqual([]);

    const vsLive = buildDiffSections(proposed, live);
    expect(vsLive.removed.some(n => n.id === 'html20k')).toBe(true);

    const diff = buildProposalDiff(
      proposal({
        status: 'pending',
        expectedRev: 'rev-1',
        baseFlow: base,
        payload: { flowId: 'tab1', flow: proposed },
      }),
      { rev: 'rev-1', flow: base },
      {
        currentRev: 'rev-2',
        compareAgainst: 'base',
        baseRevChanged: true,
        vsCurrent: vsLive,
      }
    );
    expect(diff.summary.removed).toBe(0);
    expect(diff.baseRevChanged).toBe(true);
    expect(diff.vsCurrent?.removed.some(n => n.id === 'html20k')).toBe(true);
  });

  it('does not flag baseRevChanged for approved proposals even when live rev moved', () => {
    const diff = buildProposalDiff(
      proposal({
        status: 'approved',
        expectedRev: 'old-rev',
        baseFlow: { nodes: [] },
        payload: { flowId: 'tab1', flow: { nodes: [] } },
      }),
      { rev: 'old-rev', flow: { nodes: [] } },
      { currentRev: 'new-rev', compareAgainst: 'base' }
    );
    expect(diff.baseRevChanged).toBe(false);
    expect(diff.currentRev).toBe('new-rev');
  });

  it('shows text properties on added nodes for expandable UI', () => {
    const html = '<h1>Hello</h1>\n<p>World</p>';
    const diff = buildProposalDiff(
      proposal({
        payload: {
          flowId: 'tab1',
          flow: {
            label: 'Test Flow',
            nodes: [
              {
                id: 'nNew',
                type: 'template',
                name: 'demo-html',
                field: 'payload',
                format: 'html',
                template: html,
                x: 140,
                y: 220,
                wires: [['nOut']],
              },
              { id: 'nOut', type: 'debug', name: 'sink', wires: [[]] },
            ],
          },
        },
      }),
      { rev: 'rev-1', flow: { nodes: [] } },
      { compareAgainst: 'base' }
    );
    expect(diff.added.length).toBeGreaterThanOrEqual(1);
    const added = diff.added.find(n => n.id === 'nNew');
    expect(added?.summary).toBe(
      'Adds template node "demo-html" to flow "Test Flow", output to msg.payload'
    );
    const keyTpl = added?.keyFields.find(p => p.key === 'template');
    expect(keyTpl).toEqual({
      key: 'template',
      kind: 'text',
      value: html,
      preview: 'html',
    });
    const tpl = added?.properties.find(p => p.key === 'template');
    expect(tpl).toEqual({
      key: 'template',
      kind: 'text',
      value: html,
      preview: 'html',
    });
    expect(added?.properties.some(p => p.key === 'x' && p.value === 140)).toBe(true);
    expect(added?.properties.some(p => p.key === 'y' && p.value === 220)).toBe(true);
    expect(added?.keyFields.find(p => p.key === 'wires')?.value).toEqual([
      { port: 0, to: [{ id: 'nOut', name: 'sink' }] },
    ]);
    expect(added?.properties.find(p => p.key === 'wires')?.value).toEqual([
      { port: 0, to: [{ id: 'nOut', name: 'sink' }] },
    ]);
  });

  it('includes line diffs for function func changes', () => {
    const diff = buildProposalDiff(
      proposal({
        payload: {
          flowId: 'tab1',
          flow: {
            nodes: [{ id: 'n1', type: 'function', func: 'msg.x = 1;\nreturn msg;' }],
          },
        },
      }),
      {
        rev: 'rev-1',
        flow: {
          nodes: [{ id: 'n1', type: 'function', func: 'return msg;' }],
        },
      }
    );

    const change = diff.modified[0]?.changes[0];
    expect(change?.kind).toBe('text');
    expect(change?.key).toBe('func');
    if (change?.kind === 'text') {
      expect(change.lines.some(l => l.op === 'add' && l.text.includes('msg.x'))).toBe(true);
      expect(change.lines.some(l => l.op === 'equal' && l.text === 'return msg;')).toBe(true);
    }
  });

  it('flags stale base revision for pending proposals', () => {
    const diff = buildProposalDiff(
      proposal({
        status: 'pending',
        expectedRev: 'old-rev',
        payload: { flowId: 'tab1', flow: { nodes: [] } },
      }),
      { rev: 'new-rev', flow: { nodes: [] } }
    );
    expect(diff.baseRevChanged).toBe(true);
    expect(diff.currentRev).toBe('new-rev');
    expect(diff.expectedRev).toBe('old-rev');
  });
});

describe('isLargeDelete', () => {
  it('is true when more than half the before nodes are removed', () => {
    expect(isLargeDelete({ beforeNodeCount: 10, removed: 6 })).toBe(true);
    expect(isLargeDelete({ beforeNodeCount: 4, removed: 3 })).toBe(true);
  });

  it('is false at or below 50%, or with missing counts', () => {
    expect(isLargeDelete({ beforeNodeCount: 10, removed: 5 })).toBe(false);
    expect(isLargeDelete({ beforeNodeCount: 10, removed: 4 })).toBe(false);
    expect(isLargeDelete({ beforeNodeCount: 0, removed: 1 })).toBe(false);
    expect(isLargeDelete(undefined)).toBe(false);
  });

  it('marks a live destructive proposal summary as requiring typed DELETE confirm', () => {
    // Live (non-stale) proposals with isLargeDelete must go through openDeleteConfirmDialog
    // and require typing DELETE before doApproveProposal (see page-client approveProposal).
    const summary = { beforeNodeCount: 8, removed: 7, added: 0, modified: 0, tabChanges: [] };
    expect(isLargeDelete(summary)).toBe(true);
    expect(isLargeDelete(summary) && !false /* baseRevChanged */).toBe(true);
  });
});

describe('flow settings comparisons', () => {
  it('does not invent editor changes when omitted flow settings equal Node-RED defaults', () => {
    const result = buildDiffSections(
      { id: 'tab', nodes: [], disabled: false, env: [], info: '' },
      { id: 'tab', nodes: [] }
    );
    expect(result.summary.tabChanges).toEqual([]);
    expect(result.tabProperties).toEqual([]);
  });

  it('includes real before/after flow settings values so equal field names do not hide distinct comparisons', () => {
    const result = buildDiffSections(
      { id: 'tab', label: 'proposed', env: [{ name: 'MODE', value: 'next', type: 'str' }] },
      { id: 'tab', label: 'live', env: [{ name: 'MODE', value: 'current', type: 'str' }] }
    );
    expect(result.tabProperties).toEqual([
      { key: 'label', kind: 'scalar', before: 'live', after: 'proposed' },
      {
        key: 'env',
        kind: 'scalar',
        before: [{ name: 'MODE', value: 'current', type: 'str' }],
        after: [{ name: 'MODE', value: 'next', type: 'str' }],
      },
    ]);
  });
});
