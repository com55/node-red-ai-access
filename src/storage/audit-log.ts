/**
 * Append-only JSONL audit log under `.ai-access/logs/`.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AiAccessPaths } from './paths.js';
import { sanitizeAuditDetails } from './safe.js';

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
  private seq = 0;

  constructor(
    private readonly paths: AiAccessPaths,
    private readonly now: () => number = () => Date.now()
  ) {
    this.filePath = join(paths.logs, 'audit.jsonl');
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
    // Append-only audit trail under userDir/.ai-access/logs after field
    // allowlisting above. Callers are auth-gated admin / access-link routes.
    // codeql[js/file-write]
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
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
