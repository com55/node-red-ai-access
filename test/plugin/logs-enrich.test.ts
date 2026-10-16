/**
 * Audit log enrichment — fill missing link label/expiry from the link store.
 */

import { describe, expect, it } from 'vitest';

import { AccessLinkStore } from '../../src/access/link-store.js';
import { enrichAuditLogEntry } from '../../src/plugin/logs-routes.js';
import type { AuditEntry } from '../../src/storage/audit-log.js';

describe('enrichAuditLogEntry', () => {
  it('fills label and expiresAt from the link store for old link.created rows', () => {
    const store = new AccessLinkStore({
      now: () => 1_000_000,
      randomId: () => 'link-abc',
      randomToken: () => 'aia_token',
    });
    const created = store.create({ label: 'demo-bot', ttlSeconds: 3600 });

    const entry: AuditEntry = {
      id: 'log-1',
      at: new Date(1_000_000).toISOString(),
      action: 'link.created',
      actor: { kind: 'admin', username: 'admin' },
      details: { linkId: created.id },
    };

    const enriched = enrichAuditLogEntry(entry, store);
    expect(enriched.details?.label).toBe('demo-bot');
    expect(enriched.details?.expiresAt).toBe(created.expiresAt);
    expect(enriched.details?.createdAt).toBe(created.createdAt);
    expect(enriched.details?.ttlSeconds).toBe(3600);
  });

  it('looks up revoked links still held in memory', () => {
    const store = new AccessLinkStore({
      now: () => 1_000_000,
      randomId: () => 'link-xyz',
      randomToken: () => 'aia_token2',
    });
    const created = store.create({ label: 'gone', ttlSeconds: 7200 });
    store.revoke(created.id);

    const entry: AuditEntry = {
      id: 'log-2',
      at: new Date(1_000_000).toISOString(),
      action: 'link.revoked',
      actor: { kind: 'admin' },
      details: { linkId: created.id },
    };

    const enriched = enrichAuditLogEntry(entry, store);
    expect(enriched.details?.label).toBe('gone');
    expect(enriched.details?.expiresAt).toBe(created.expiresAt);
  });

  it('leaves rows alone when details are already complete', () => {
    const store = new AccessLinkStore({
      now: () => 1_000_000,
      randomId: () => 'link-keep',
      randomToken: () => 'aia_token3',
    });
    store.create({ label: 'other', ttlSeconds: 3600 });

    const entry: AuditEntry = {
      id: 'log-3',
      at: new Date(1_000_000).toISOString(),
      action: 'link.created',
      actor: { kind: 'admin' },
      details: {
        linkId: 'unknown',
        label: 'kept',
        expiresAt: '2099-01-01T00:00:00.000Z',
        createdAt: '2099-01-01T00:00:00.000Z',
        ttlSeconds: 99,
      },
    };

    const enriched = enrichAuditLogEntry(entry, store);
    expect(enriched.details).toEqual(entry.details);
  });
});
