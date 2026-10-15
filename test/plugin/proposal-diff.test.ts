import { describe, expect, it } from 'vitest';

import { buildProposalDiff } from '../../src/plugin/proposal-diff.js';
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
  it('counts added, removed, and modified nodes', () => {
    const diff = buildProposalDiff(
      proposal({
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
      }
    );

    expect(diff.summary).toEqual({
      added: 1,
      removed: 1,
      modified: 1,
      tabChanges: ['label'],
    });
    expect(diff.baseRevStale).toBe(false);
    expect(diff.added).toEqual([{ id: 'n3', type: 'debug', name: 'out' }]);
    expect(diff.removed).toEqual([{ id: 'n2', type: 'function', name: 'fn' }]);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]?.id).toBe('n1');
    expect(diff.modified[0]?.changes).toEqual([
      { key: 'topic', kind: 'scalar', before: 'old', after: 'changed' },
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

  it('flags stale base revision', () => {
    const diff = buildProposalDiff(
      proposal({
        expectedRev: 'old-rev',
        payload: { flowId: 'tab1', flow: { nodes: [] } },
      }),
      { rev: 'new-rev', flow: { nodes: [] } }
    );
    expect(diff.baseRevStale).toBe(true);
    expect(diff.currentRev).toBe('new-rev');
    expect(diff.expectedRev).toBe('old-rev');
  });
});
