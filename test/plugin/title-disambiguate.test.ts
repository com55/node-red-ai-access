/**
 * Title collision disambiguation: · HH:mm (not relative "12h ago"), #n on ties.
 */

import { describe, expect, it } from 'vitest';

import { buildDisambiguatedTitleMap, formatClockHm } from '../../src/plugin/title-disambiguate.js';

describe('title-disambiguate', () => {
  it('formatClockHm returns HH:mm in local time', () => {
    const iso = '2026-10-15T14:05:30.000Z';
    const d = new Date(iso);
    const expected =
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    expect(formatClockHm(iso)).toBe(expected);
  });

  it('leaves unique titles alone', () => {
    const map = buildDisambiguatedTitleMap([
      {
        id: 'a',
        baseTitle: 'Replace Test Flow: deletes 4 nodes',
        createdAt: '2026-10-15T01:00:00.000Z',
      },
      { id: 'b', baseTitle: 'Edit node in Main', createdAt: '2026-10-15T02:00:00.000Z' },
    ]);
    expect(map.a).toBe('Replace Test Flow: deletes 4 nodes');
    expect(map.b).toBe('Edit node in Main');
  });

  it('appends · HH:mm when two stale cards share a base title', () => {
    const t1 = '2026-10-15T10:15:00.000Z';
    const t2 = '2026-10-15T11:40:00.000Z';
    const base = 'Replace Test Flow: deletes 4 nodes';
    const map = buildDisambiguatedTitleMap([
      { id: 'stale-1', baseTitle: base, createdAt: t1 },
      { id: 'stale-2', baseTitle: base, createdAt: t2 },
    ]);
    expect(map['stale-1']).toBe(base + ' · ' + formatClockHm(t1));
    expect(map['stale-2']).toBe(base + ' · ' + formatClockHm(t2));
    expect(map['stale-1']).not.toMatch(/ago/);
    expect(map['stale-2']).not.toMatch(/ago/);
    expect(map['stale-1']).not.toBe(map['stale-2']);
  });

  it('appends #1/#2 when clock times also collide', () => {
    const t = '2026-10-15T10:15:00.000Z';
    const base = 'Replace Test Flow: deletes 4 nodes';
    const map = buildDisambiguatedTitleMap([
      { id: 'z', baseTitle: base, createdAt: t },
      { id: 'a', baseTitle: base, createdAt: t },
    ]);
    const hm = formatClockHm(t);
    expect(map.a).toBe(base + ' · ' + hm + ' #1');
    expect(map.z).toBe(base + ' · ' + hm + ' #2');
  });
});
