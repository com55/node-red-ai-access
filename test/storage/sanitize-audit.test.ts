/**
 * Audit detail sanitizer — link create/revoke fields must not be stripped.
 */

import { describe, expect, it } from 'vitest';

import { sanitizeAuditDetails } from '../../src/storage/safe.js';

describe('sanitizeAuditDetails', () => {
  it('keeps the real link.created field set (label, expiry, ttlSeconds, linkId)', () => {
    const details = sanitizeAuditDetails({
      linkId: 'abc123def456',
      label: 'smoke-test-d546bec',
      expiresAt: '2026-10-17T01:00:00.000Z',
      createdAt: '2026-10-16T01:00:00.000Z',
      ttlSeconds: 86_400,
      // Unknown keys stay out (allow-list).
      evil: '<script>',
    });
    expect(details).toEqual({
      linkId: 'abc123def456',
      label: 'smoke-test-d546bec',
      expiresAt: '2026-10-17T01:00:00.000Z',
      createdAt: '2026-10-16T01:00:00.000Z',
      ttlSeconds: 86_400,
    });
    expect(details).not.toHaveProperty('evil');
  });

  it('preserves flowLabel for proposal audit rows', () => {
    expect(
      sanitizeAuditDetails({
        proposalId: 'prop-1',
        title: 'Add inject',
        flowLabel: 'Test Flow',
        flowId: 'tab1',
      })
    ).toMatchObject({
      proposalId: 'prop-1',
      title: 'Add inject',
      flowLabel: 'Test Flow',
      flowId: 'tab1',
    });
  });
});
