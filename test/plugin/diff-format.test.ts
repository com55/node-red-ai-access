import { describe, expect, it } from 'vitest';

import { applyDiffFormat, resolveDiffFormat } from '../../src/plugin/diff-format.js';
import type { ProposalDiffResult } from '../../src/plugin/proposal-diff.js';

function sampleDiff(linesEqualCount: number): ProposalDiffResult {
  const equal = Array.from({ length: linesEqualCount }, (_, i) => ({
    op: 'equal' as const,
    text: `eq-${i}`,
  }));
  return {
    compareAgainst: 'base',
    summary: {
      added: 0,
      removed: 0,
      modified: 1,
      tabChanges: [],
      beforeNodeCount: 1,
      afterNodeCount: 1,
    },
    added: [],
    removed: [],
    modified: [
      {
        id: 'n1',
        type: 'function',
        summary: 'Changes function node (1 field)',
        changes: [
          {
            key: 'func',
            kind: 'text',
            before: 'a'.repeat(100),
            after: 'b'.repeat(120),
            lines: [...equal, { op: 'remove', text: 'old' }, { op: 'add', text: 'new' }, ...equal],
          },
        ],
      },
    ],
  };
}

describe('diff-format', () => {
  it('defaults to summary and rejects unknown formats', () => {
    expect(resolveDiffFormat(undefined)).toEqual({ ok: true, format: 'summary' });
    expect(resolveDiffFormat('')).toEqual({ ok: true, format: 'summary' });
    expect(resolveDiffFormat('summary')).toEqual({ ok: true, format: 'summary' });
    expect(resolveDiffFormat('full')).toEqual({ ok: true, format: 'full' });
    expect(resolveDiffFormat('bogus')).toEqual({ ok: false });
  });

  it('summary collapses equal context, sets byte sizes, and omits before/after', () => {
    const formatted = applyDiffFormat(sampleDiff(20), 'summary');
    expect(formatted.format).toBe('summary');
    const change = formatted.modified[0]?.changes[0];
    expect(change?.kind).toBe('text');
    if (change?.kind === 'text') {
      expect(change.beforeBytes).toBe(100);
      expect(change.afterBytes).toBe(120);
      expect(change.before).toBeUndefined();
      expect(change.after).toBeUndefined();
      expect(change.truncated).toBe(true);
      expect(change.lines.some(l => l.text.includes('unchanged line'))).toBe(true);
      expect(change.lines.length).toBeLessThan(43);
      // Summary must not embed the full strings (regression: ~42KB for a tiny edit).
      expect(JSON.stringify(change).length).toBeLessThan(2_000);
    }
  });

  it('full keeps all lines and before/after strings', () => {
    const formatted = applyDiffFormat(sampleDiff(20), 'full');
    const change = formatted.modified[0]?.changes[0];
    if (change?.kind === 'text') {
      expect(change.truncated).toBeUndefined();
      expect(change.lines).toHaveLength(42);
      expect(change.beforeBytes).toBe(100);
      expect(change.before).toBe('a'.repeat(100));
      expect(change.after).toBe('b'.repeat(120));
    }
  });
});
