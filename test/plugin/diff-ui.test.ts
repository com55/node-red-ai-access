import { describe, expect, it } from 'vitest';

import {
  DIFF_SPLIT_MIN_PX,
  PRESENCE_SHORT_TEXT_MAX,
  defaultDiffMode,
  isCollapsiblePresenceText,
} from '../../src/plugin/diff-ui.js';

describe('defaultDiffMode', () => {
  it('defaults to side-by-side on wide viewports', () => {
    expect(defaultDiffMode(DIFF_SPLIT_MIN_PX)).toBe('split');
    expect(defaultDiffMode(1400)).toBe('split');
  });

  it('defaults to unified below the narrow breakpoint', () => {
    expect(defaultDiffMode(DIFF_SPLIT_MIN_PX - 1)).toBe('unified');
    expect(defaultDiffMode(320)).toBe('unified');
  });
});

describe('isCollapsiblePresenceText', () => {
  it('keeps short single-line fields inline (format, syntax, …)', () => {
    expect(isCollapsiblePresenceText('html')).toBe(false);
    expect(isCollapsiblePresenceText('mustache')).toBe(false);
    expect(isCollapsiblePresenceText('x'.repeat(PRESENCE_SHORT_TEXT_MAX))).toBe(false);
  });

  it('collapses multi-line or over-length text', () => {
    expect(isCollapsiblePresenceText('line1\nline2')).toBe(true);
    expect(isCollapsiblePresenceText('x'.repeat(PRESENCE_SHORT_TEXT_MAX + 1))).toBe(true);
  });

  it('does not collapse non-strings', () => {
    expect(isCollapsiblePresenceText(12)).toBe(false);
    expect(isCollapsiblePresenceText(null)).toBe(false);
  });
});
