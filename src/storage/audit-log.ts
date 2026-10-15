/**
 * Append-only JSONL audit log under `.ai-access/logs/`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AiAccessPaths } from './paths.js';
import { sanitizeAuditDetails } from './safe.js';
import { MAX_AUDIT_APPEND_BYTES, appendTrusted, encodeTrustedJson } from './trusted-write.js';

export type AuditActor =
  | { kind: 'access-link'; linkId: string; label?: string }
  | { kind: 'admin'; username?: string }
  | { kind: 'system' };

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  actor: AuditActor;
  details?: Record<string, unknown>;
}

const SAFE_ACTION_RE = /^[a-z][a-z0-9._-]{0,63}$/;

function sanitizeActor(actor: AuditActor): AuditActor {
  if (actor.kind === 'system') {
    return { kind: 'system' };
  }
  if (actor.kind === 'access-link') {
    const out: { kind: 'access-link'; linkId: string; label?: string } = {
      kind: 'access-link',
      linkId: String(actor.linkId).replace(/\0/g, '').slice(0, 200),
    };
    if (typeof actor.label === 'string') {
      out.label = actor.label.replace(/\0/g, '').slice(0, 200);
    }
    return out;
  }
  const out: { kind: 'admin'; username?: string } = { kind: 'admin' };
  if (typeof actor.username === 'string') {
    out.username = actor.username.replace(/\0/g, '').slice(0, 200);
  }
  return out;
}

export class AuditLog {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly maxAppendBytes: number;
  private seq = 0;

  constructor(
    private readonly paths: AiAccessPaths,
    options: { now?: () => number; maxAppendBytes?: number } = {}
  ) {
    this.filePath = join(paths.logs, 'audit.jsonl');
    this.now = options.now ?? (() => Date.now());
    this.maxAppendBytes = options.maxAppendBytes ?? MAX_AUDIT_APPEND_BYTES;
  }

  append(action: string, actor: AuditActor, details?: Record<string, unknown>): AuditEntry {
    const safeAction = SAFE_ACTION_RE.test(action) ? action : 'unknown';
    this.seq += 1;
    const entry: AuditEntry = {
      id: `log-${this.now()}-${this.seq}`,
      at: new Date(this.now()).toISOString(),
      action: safeAction,
      actor: sanitizeActor(actor),
    };
    if (details !== undefined) {
      entry.details = sanitizeAuditDetails(details);
    }
    const payload = encodeTrustedJson(entry, this.maxAppendBytes, { kind: 'audit' });
    appendTrusted(this.paths.root, this.filePath, payload);
    return entry;
  }

  list(limit = 100): AuditEntry[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const lines = readFileSync(this.filePath, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const entries: AuditEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // skip corrupt lines
      }
    }
    return entries.slice(-Math.max(1, limit)).reverse();
  }
}
