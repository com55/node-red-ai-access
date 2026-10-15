/**
 * Paths and absolute URLs for self-contained GET access links (`/mcp/a/<token>`).
 */

import type { Request } from 'express';

import { normalizeHttpAdminRoot } from './auth.js';

/** Default access-link TTL: 4 hours. */
export const DEFAULT_ACCESS_LINK_TTL_SECONDS = 14_400;

/** Soft cap for GET propose / draft URLs (~8KB). */
export const MAX_GET_ACCESS_URL_BYTES = 8_192;

/** In-memory draft lifetime. */
export const DRAFT_TTL_MS = 30 * 60 * 1000;

/**
 * Absolute admin path for one access link (token not URL-encoded here —
 * callers encode when embedding in Location/href).
 */
export function mcpAccessLinkPath(httpAdminRoot: string | undefined, token: string): string {
  const root = normalizeHttpAdminRoot(httpAdminRoot);
  const base = root === '/' ? '/mcp/a' : `${root}/mcp/a`;
  return `${base}/${token}`;
}

/** Prefix under which all GET-link routes live (no trailing slash). */
export function mcpAccessLinkBase(httpAdminRoot: string | undefined): string {
  const root = normalizeHttpAdminRoot(httpAdminRoot);
  return root === '/' ? '/mcp/a' : `${root}/mcp/a`;
}

/**
 * Build a shareable absolute URL for an access link from the creating request.
 * Falls back to a root-relative path when Host is unavailable.
 */
export function buildAccessLinkUrl(
  req: Request,
  httpAdminRoot: string | undefined,
  token: string
): string {
  const path = mcpAccessLinkPath(httpAdminRoot, token);
  const host = req.get('x-forwarded-host') ?? req.get('host');
  if (!host) {
    return path;
  }
  const forwarded = req.get('x-forwarded-proto');
  const firstForwarded =
    typeof forwarded === 'string' && forwarded.length > 0
      ? forwarded.split(',')[0]?.trim()
      : undefined;
  const proto = firstForwarded ?? (req.protocol || 'http');
  return `${proto}://${host}${path}`;
}

/** Redact `aia_…` path segments for logs / audit (never store raw tokens). */
export function redactAccessLinkTokenInPath(path: string): string {
  return path.replace(/\/mcp\/a\/[^/?#]+/gi, '/mcp/a/<redacted>');
}
