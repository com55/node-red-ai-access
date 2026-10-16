/**
 * Unit tests for the in-memory AccessLinkStore.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AccessLinkLimitError, AccessLinkStore } from '../../src/access/index.js';

describe('AccessLinkStore', () => {
  it('creates a link with default 4h TTL and returns the raw token once', () => {
    const now = 1_700_000_000_000;
    const store = new AccessLinkStore({
      now: () => now,
      randomId: () => 'link-1',
      randomToken: () => 'aia_test-token',
    });

    const created = store.create({ label: 'demo' });
    expect(created).toMatchObject({
      id: 'link-1',
      kind: 'get_link',
      token: 'aia_test-token',
      label: 'demo',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 14_400_000).toISOString(),
    });

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('token');
    expect(listed[0]).not.toHaveProperty('tokenHash');
    expect(listed[0]!.kind).toBe('get_link');
  });

  it('persists kind on create and defaults omitted kind to get_link', () => {
    const store = new AccessLinkStore();
    expect(store.create().kind).toBe('get_link');
    expect(store.create({ kind: 'rest' }).kind).toBe('rest');
    expect(store.create({ kind: 'mcp' }).kind).toBe('mcp');
    expect(store.validate(store.create({ kind: 'rest' }).token)?.kind).toBe('rest');
  });

  it('treats legacy records without kind as get_link in list/validate', () => {
    const now = 1_700_000_000_000;
    const store = new AccessLinkStore({ now: () => now });
    store.upsertRecordForTest({
      id: 'legacy-1',
      tokenHash: createHash('sha256').update('aia_legacy-token', 'utf8').digest('hex'),
      token: 'aia_legacy-token',
      // no kind — pre-migration shape
      createdAtMs: now,
      expiresAtMs: now + 3_600_000,
    });

    expect(store.list()[0]!.kind).toBe('get_link');
    expect(store.validate('aia_legacy-token')?.kind).toBe('get_link');
    expect(store.getById('legacy-1')?.kind).toBe('get_link');
  });

  it('honors creator-supplied ttlSeconds', () => {
    const now = 1_000_000;
    const store = new AccessLinkStore({ now: () => now });
    const created = store.create({ ttlSeconds: 60 });
    expect(created.expiresAt).toBe(new Date(now + 60_000).toISOString());
  });

  it('rejects creating more than maxActiveLinks active links', () => {
    const store = new AccessLinkStore({ maxActiveLinks: 2 });
    store.create();
    store.create();
    expect(() => store.create()).toThrow(AccessLinkLimitError);
  });

  it('validate accepts a live token and rejects unknown/expired/revoked', () => {
    let now = 1_000_000;
    const store = new AccessLinkStore({
      now: () => now,
      randomToken: () => 'aia_live',
    });

    const created = store.create({ ttlSeconds: 10 });
    expect(store.validate(created.token)?.id).toBe(created.id);
    expect(store.validate('aia_unknown')).toBeNull();

    now += 11_000;
    expect(store.validate(created.token)).toBeNull();

    now = 1_000_000;
    const store2 = new AccessLinkStore({
      now: () => now,
      randomToken: () => 'aia_revoked',
    });
    const second = store2.create({ ttlSeconds: 100 });
    store2.revoke(second.id);
    expect(store2.validate(second.token)).toBeNull();
  });

  it('clear (restart) invalidates every prior token', () => {
    const store = new AccessLinkStore({ randomToken: () => 'aia_restart' });
    const created = store.create();
    expect(store.validate(created.token)).not.toBeNull();
    store.clear();
    expect(store.validate(created.token)).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('stores only a hash — list never echoes the raw token', () => {
    const store = new AccessLinkStore({ randomToken: () => 'aia_secret-token-value' });
    store.create({ label: 'x' });
    const serialized = JSON.stringify(store.list());
    expect(serialized).not.toContain('aia_secret-token-value');
  });
});
