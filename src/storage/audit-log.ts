/**
 * Append-only JSONL audit log under `.ai-access/logs/`.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AiAccessPaths } from './paths.js';

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
    this.seq += 1;
    const entry: AuditEntry = {
      id: `log-${this.now()}-${this.seq}`,
      at: new Date(this.now()).toISOString(),
      action,
      actor,
    };
    if (details !== undefined) {
      entry.details = details;
    }
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
