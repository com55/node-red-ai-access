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

/** True when Express `trust proxy` is enabled on this request's app. */
export function isTrustProxyEnabled(req: Request): boolean {
  return Boolean(req.app.get('trust proxy'));
}

function firstForwardedHost(req: Request): string | undefined {
  const forwarded = req.get('x-forwarded-host');
  if (typeof forwarded !== 'string' || forwarded.length === 0) {
    return undefined;
  }
  const first = forwarded.split(',')[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/**
 * Public origin (`https://host[:port]`) for absolute URLs.
 * Uses `X-Forwarded-Host` / `req.protocol` (which honors `X-Forwarded-Proto`)
 * only when Express `trust proxy` is set; otherwise uses `Host` + socket proto.
 * Returns undefined when no Host is available.
 */
export function requestPublicOrigin(req: Request): string | undefined {
  const trust = isTrustProxyEnabled(req);
  const host = trust ? (firstForwardedHost(req) ?? req.get('host')) : req.get('host');
  if (!host) {
    return undefined;
  }
  return `${req.protocol}://${host}`;
}

/** Join origin + path, or return path alone when origin is unknown. */
export function absolutizePath(req: Request, path: string): string {
  const origin = requestPublicOrigin(req);
  return origin ? `${origin}${path}` : path;
}

/**
 * Build a shareable absolute URL for an access link from the creating request.
 * Falls back to a root-relative path when Host is unavailable.
 * Honors `X-Forwarded-*` only when Express `trust proxy` is enabled.
 */
export function buildAccessLinkUrl(
  req: Request,
  httpAdminRoot: string | undefined,
  token: string
): string {
  return absolutizePath(req, mcpAccessLinkPath(httpAdminRoot, token));
}

/** Redact `aia_…` path segments for logs / audit (never store raw tokens). */
export function redactAccessLinkTokenInPath(path: string): string {
  return path.replace(/\/mcp\/a\/[^/?#]+/gi, '/mcp/a/<redacted>');
}
