import { describe, expect, it } from 'vitest';

import { applyDiffFormat } from '../../src/plugin/diff-format.js';
import { alignSplitDiffLines, diffLines } from '../../src/plugin/line-diff.js';
import { buildProposalDiff } from '../../src/plugin/proposal-diff.js';
import type { Proposal } from '../../src/storage/proposals.js';

describe('diffLines', () => {
  it('marks equal lines', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([
      { op: 'equal', text: 'a' },
      { op: 'equal', text: 'b' },
    ]);
  });

  it('detects added and removed lines', () => {
    const result = diffLines('keep\nold\nend', 'keep\nnew\nend');
    expect(result).toEqual([
      { op: 'equal', text: 'keep' },
      { op: 'remove', text: 'old' },
      { op: 'add', text: 'new' },
      { op: 'equal', text: 'end' },
    ]);
  });

  it('handles empty before (all adds)', () => {
    expect(diffLines('', 'x\ny')).toEqual([
      { op: 'add', text: 'x' },
      { op: 'add', text: 'y' },
    ]);
  });

  it('handles empty after (all removes)', () => {
    expect(diffLines('x\ny', '')).toEqual([
      { op: 'remove', text: 'x' },
      { op: 'remove', text: 'y' },
    ]);
  });
});

describe('alignSplitDiffLines', () => {
  it('pairs a remove-then-add replace so AFTER content is on the first rows', () => {
    // Simulates a large template replace: all old lines removed, then all new added.
    const before = Array.from({ length: 40 }, (_, i) => `old-${i}`).join('\n');
    const after = Array.from({ length: 40 }, (_, i) => `new-${i}`).join('\n');
    const lines = diffLines(before, after);
    const rows = alignSplitDiffLines(lines);

    expect(rows[0]?.left?.op).toBe('remove');
    expect(rows[0]?.right?.op).toBe('add');
    expect(rows[0]?.right?.text).toBe('new-0');
    // Without pairing, AFTER would start with 40 blank placeholders.
    expect(rows.slice(0, 5).every(r => r.right?.op === 'add')).toBe(true);
  });

  it('keeps equal lines aligned and pairs a mid-hunk replace', () => {
    const rows = alignSplitDiffLines(diffLines('keep\nold\nend', 'keep\nnew\nend'));
    expect(rows).toEqual([
      {
        left: { op: 'equal', text: 'keep' },
        right: { op: 'equal', text: 'keep' },
      },
      {
        left: { op: 'remove', text: 'old' },
        right: { op: 'add', text: 'new' },
      },
      {
        left: { op: 'equal', text: 'end' },
        right: { op: 'equal', text: 'end' },
      },
    ]);
  });

  it('pairs large same-byte-size template bodies used by html20k-style proposals', () => {
    const pad = (tag: string) =>
      Array.from({ length: 200 }, (_, i) => `<p class="${tag}-${i}">${'x'.repeat(80)}</p>`).join(
        '\n'
      );
    const before = pad('a');
    const after = pad('b');
    expect(Buffer.byteLength(before, 'utf8')).toBeGreaterThan(15_000);
    expect(Buffer.byteLength(after, 'utf8')).toBe(Buffer.byteLength(before, 'utf8'));

    const proposal: Proposal = {
      id: 'prop-html20k',
      type: 'replace_flow',
      status: 'pending',
      expectedRev: 'rev-1',
      createdBy: { kind: 'access-link', linkId: 'link-1' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      baseFlow: {
        id: 'tab1',
        nodes: [{ id: 'n1', type: 'template', name: 'html20k', template: before }],
      },
      payload: {
        flowId: 'tab1',
        flow: {
          id: 'tab1',
          nodes: [{ id: 'n1', type: 'template', name: 'html20k', template: after }],
        },
      },
    };
    const diff = applyDiffFormat(
      buildProposalDiff(
        proposal,
        {
          rev: 'rev-1',
          flow: {
            id: 'tab1',
            nodes: [{ id: 'n1', type: 'template', name: 'html20k', template: before }],
          },
        },
        { compareAgainst: 'base' }
      ),
      'summary'
    );
    const change = diff.modified[0]?.changes.find(c => c.key === 'template');
    expect(change?.kind).toBe('text');
    if (change?.kind !== 'text') {
      return;
    }
    const rows = alignSplitDiffLines(change.lines);
    expect(rows.length).toBeGreaterThan(0);
    const firstContent = rows.find(r => r.right?.op === 'add' || r.right?.op === 'equal');
    expect(firstContent?.right?.text).toBeTruthy();
    // First visible AFTER row must not be buried under a long blank prefix.
    const firstAddIdx = rows.findIndex(r => r.right?.op === 'add');
    expect(firstAddIdx).toBeGreaterThanOrEqual(0);
    expect(firstAddIdx).toBeLessThan(5);
  });
});
