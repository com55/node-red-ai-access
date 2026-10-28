/**
 * Audit how many `[REDACTED]` placeholders each AI-facing response carried
 * (counts and operation only — never values).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { NextFunction, Request, Response } from 'express';

import type { AuditActor, AuditLog } from '../storage/audit-log.js';

import { countRedactionPlaceholders } from './secret-redaction.js';
import type { AuthenticatedRequest } from './types.js';

export const REDACTION_AUDIT_ACTION = 'ai.redacted';

interface RedactionAuditScope {
  record(count: number): void;
}

const scope = new AsyncLocalStorage<RedactionAuditScope>();

function appendRedactionAudit(
  audit: AuditLog,
  actor: AuditActor,
  operation: string,
  count: number
): void {
  if (count <= 0) return;
  try {
    audit.append(REDACTION_AUDIT_ACTION, actor, { redactions: count, operation });
  } catch {
    // Audit is best-effort; never fail the AI response.
  }
}

/** Note placeholders in a serialized MCP tool result (no-op outside a scope). */
export function noteResponseRedactions(serialized: string): void {
  const active = scope.getStore();
  if (!active) return;
  const count = countRedactionPlaceholders(serialized);
  if (count > 0) active.record(count);
}

/** Run an MCP request so tool results inside it are audited. */
export function runWithRedactionAudit<T>(
  audit: AuditLog,
  actor: AuditActor,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  return scope.run({ record: count => appendRedactionAudit(audit, actor, operation, count) }, fn);
}

/** MCP JSON-RPC operation label (`mcp:<tool>`), never arguments. */
export function mcpOperationName(body: unknown): string {
  const msg: unknown = Array.isArray(body) ? (body as unknown[])[0] : body;
  if (msg && typeof msg === 'object') {
    const m = msg as { method?: unknown; params?: { name?: unknown } };
    if (m.method === 'tools/call' && typeof m.params?.name === 'string') {
      return `mcp:${m.params.name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)}`;
    }
    if (typeof m.method === 'string') return `mcp:${m.method.slice(0, 64)}`;
  }
  return 'mcp';
}

export function accessLinkAuditActor(req: AuthenticatedRequest): AuditActor | undefined {
  const link = req.accessLink;
  if (!link) return undefined;
  return {
    kind: 'access-link',
    linkId: link.id,
    ...(link.label !== undefined ? { label: link.label } : {}),
  };
}

/**
 * Express middleware: wrap `res.json` so AI (access-link) responses under
 * `/mcp` are audited with their placeholder count. Admin-session responses
 * are never redacted and never audited here. The operation is the matched
 * route pattern (no tokens, ids, or query strings).
 */
export function redactionAuditMiddleware(audit: AuditLog) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.startsWith('/mcp/') || req.path.startsWith('/mcp/rpc')) {
      next();
      return;
    }
    const original = res.json.bind(res);
    res.json = ((body: unknown) => {
      const actor = accessLinkAuditActor(req as AuthenticatedRequest);
      if (actor && res.statusCode < 400) {
        let text: string;
        try {
          text = String(JSON.stringify(body));
        } catch {
          text = '';
        }
        const route: unknown = (req as { route?: { path?: unknown } }).route?.path;
        const operation = `${req.method} ${typeof route === 'string' ? route : 'unknown'}`;
        appendRedactionAudit(audit, actor, operation, countRedactionPlaceholders(text));
      }
      return original(body);
    }) as Response['json'];
    next();
  };
}
