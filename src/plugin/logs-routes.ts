/**
 * Audit log read API.
 */

import type { Response } from 'express';

import type { AuditLog } from '../storage/audit-log.js';

import type { AuthenticatedRequest } from './types.js';

export function listLogsHandler(audit: AuditLog) {
  return (req: AuthenticatedRequest, res: Response): void => {
    const raw = req.query.limit;
    let limit = 100;
    if (typeof raw === 'string' && raw.length > 0) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(Math.floor(parsed), 500);
      }
    }
    res.json({ logs: audit.list(limit) });
  };
}
