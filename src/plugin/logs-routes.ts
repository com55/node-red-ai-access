/**
 * Audit log read API.
 */

import type { Response } from 'express';

import type { AccessLinkStore } from '../access/link-store.js';
import type { AuditEntry, AuditLog } from '../storage/audit-log.js';

import type { AuthenticatedRequest } from './types.js';

function ttlSecondsFromLink(link: { createdAt: string; expiresAt: string }): number | undefined {
  const createdAtMs = Date.parse(link.createdAt);
  const expiresAtMs = Date.parse(link.expiresAt);
  if (Number.isFinite(createdAtMs) && Number.isFinite(expiresAtMs) && expiresAtMs > createdAtMs) {
    return Math.round((expiresAtMs - createdAtMs) / 1000);
  }
  return undefined;
}

/**
 * Older link.created / link.revoked rows may omit label/expiry. Fill from the
 * in-memory link store (including revoked) at display/list time.
 */
export function enrichAuditLogEntry(entry: AuditEntry, linkStore?: AccessLinkStore): AuditEntry {
  if (!linkStore) {
    return entry;
  }
  if (entry.action !== 'link.created' && entry.action !== 'link.revoked') {
    return entry;
  }
  const details = { ...(entry.details ?? {}) };
  const linkId = typeof details.linkId === 'string' ? details.linkId : '';
  if (!linkId) {
    return entry;
  }
  const missingLabel = details.label == null || details.label === '';
  const missingExpires = details.expiresAt == null || details.expiresAt === '';
  const missingCreated = details.createdAt == null || details.createdAt === '';
  const missingTtl = details.ttlSeconds == null;
  if (!missingLabel && !missingExpires && !missingCreated && !missingTtl) {
    return entry;
  }
  const link = linkStore.getById(linkId);
  if (!link) {
    return entry;
  }
  if (missingLabel && link.label) {
    details.label = link.label;
  }
  if (missingExpires) {
    details.expiresAt = link.expiresAt;
  }
  if (missingCreated) {
    details.createdAt = link.createdAt;
  }
  if (missingTtl) {
    const ttl = ttlSecondsFromLink(link);
    if (ttl !== undefined) {
      details.ttlSeconds = ttl;
    }
  }
  return { ...entry, details };
}

export function listLogsHandler(audit: AuditLog, linkStore?: AccessLinkStore) {
  return (req: AuthenticatedRequest, res: Response): void => {
    const raw = req.query.limit;
    let limit = 100;
    if (typeof raw === 'string' && raw.length > 0) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(Math.floor(parsed), 500);
      }
    }
    const logs = audit.list(limit).map(entry => enrichAuditLogEntry(entry, linkStore));
    res.json({ logs });
  };
}
