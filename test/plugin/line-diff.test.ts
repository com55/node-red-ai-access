import { describe, expect, it } from 'vitest';

import { diffLines } from '../../src/plugin/line-diff.js';

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
