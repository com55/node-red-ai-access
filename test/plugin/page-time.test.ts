import { describe, expect, it } from 'vitest';

import {
  buildLocalProposalHeading,
  formatLocalCompact,
  formatLocalShort,
  titleFromDisplayName,
} from '../../src/plugin/page-time.js';

describe('titleFromDisplayName', () => {
  it('strips the server datetime suffix after the last ·', () => {
    expect(titleFromDisplayName('Rename inject · 16 Oct 01:35 +00:00')).toBe('Rename inject');
    expect(titleFromDisplayName('Add "a · b" (inject) · 1 Jan 12:00 -05:00')).toBe(
      'Add "a · b" (inject)'
    );
    expect(titleFromDisplayName('No separator')).toBe('No separator');
  });
});

describe('formatLocalShort / formatLocalCompact', () => {
  it('formats via Intl.DateTimeFormat in the given locale (browser-local, no offset)', () => {
    const iso = '2026-10-16T01:35:00.000Z';
    const d = new Date(iso);
    // Match Intl directly so CI host TZ does not flake absolute clock faces.
    expect(formatLocalShort(iso, 'en-GB', d)).toBe(
      new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(d)
    );
    expect(formatLocalShort(iso, 'en-GB', d)).not.toMatch(/[+-]\d{2}:\d{2}/);

    expect(formatLocalCompact(iso, 'en-GB', d)).toBe(
      new Intl.DateTimeFormat('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(d)
    );
    expect(formatLocalCompact(iso, 'en-GB', d)).not.toMatch(/[+-]\d{2}:\d{2}/);
  });
});

describe('buildLocalProposalHeading', () => {
  it('rebuilds title · local time and never returns raw displayName', () => {
    const heading = buildLocalProposalHeading({
      displayName: 'Rename inject · 16 Oct 01:35 +00:00',
      createdAt: '2026-10-16T01:35:00.000Z',
    });
    expect(heading.title).toBe('Rename inject');
    expect(heading.when).toBeTruthy();
    expect(heading.when).not.toContain('+00:00');
    expect(`${heading.title} · ${heading.when}`).not.toBe('Rename inject · 16 Oct 01:35 +00:00');
  });

  it('prefers explicit title over displayName prefix', () => {
    const heading = buildLocalProposalHeading({
      title: 'Custom',
      displayName: 'Other · 16 Oct 01:35 +00:00',
      createdAt: '2026-10-16T01:35:00.000Z',
    });
    expect(heading.title).toBe('Custom');
  });
});
