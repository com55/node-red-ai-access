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

function firstForwardedValue(req: Request, header: string): string | undefined {
  const forwarded = req.get(header);
  if (typeof forwarded !== 'string' || forwarded.length === 0) {
    return undefined;
  }
  const first = forwarded.split(',')[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/** Explicit public base URL from `settings.aiAccess.publicBaseUrl` (normalized). */
let configuredPublicBaseUrl: string | undefined;

/**
 * Normalize a configured public base URL: must be absolute http(s); trailing
 * slashes, query and fragment are dropped. Returns undefined when invalid/empty.
 */
export function normalizePublicBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Settings Public URL: an HTTPS origin, or HTTP loopback for local development. */
export function validateSettingsPublicBaseUrl(value: unknown): string {
  if (value === '') return '';
  const message =
    'publicBaseUrl must be an HTTPS origin with no path, query, fragment, or credentials (HTTP localhost is allowed)';
  if (typeof value !== 'string') throw new Error(message);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(message);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    !/^https?:\/\/[^/?#]+\/?$/i.test(value.trim()) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    value.includes('?') ||
    value.includes('#')
  )
    throw new Error(message);
  return url.origin;
}

/** Bind (or clear) the explicit public base URL used for absolute URLs. */
export function bindPublicBaseUrl(value: unknown): void {
  configuredPublicBaseUrl = normalizePublicBaseUrl(value);
}

const DNS_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const HOSTNAME_RE = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_LITERAL_RE = /^\[[0-9A-Fa-f:.]+\]$/;

/**
 * Strictly validate a `host[:port]` value (Host / X-Forwarded-Host).
 * Accepts a DNS hostname (≤253 chars), IPv4, or a bracketed IPv6 literal, each
 * with an optional port 1-65535. Anything else (userinfo, path, query,
 * fragment, whitespace, other characters) is rejected.
 */
export function isValidHostHeader(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 260) return false;
  let host: string;
  let port: string | undefined;
  const v6 = /^(\[[^\]]*\])(?::(\d+))?$/.exec(value);
  if (v6) {
    host = v6[1]!;
    port = v6[2];
    if (!IPV6_LITERAL_RE.test(host)) return false;
    try {
      new URL(`http://${host}/`);
    } catch {
      return false;
    }
  } else {
    const m = /^([^:]+)(?::(\d+))?$/.exec(value);
    if (!m) return false;
    host = m[1]!;
    port = m[2];
    if (host.length > 253) return false;
    if (!IPV4_RE.test(host) && !HOSTNAME_RE.test(host)) return false;
  }
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port)) return false;
    const n = Number(port);
    if (n < 1 || n > 65535) return false;
  }
  return true;
}

/** `http` | `https` from a header value (case-insensitive, trimmed), else undefined. */
function validScheme(value: string | undefined): 'http' | 'https' | undefined {
  const v = value?.trim().toLowerCase();
  return v === 'http' || v === 'https' ? v : undefined;
}

/** Scheme of the actual connection (ignores X-Forwarded-Proto). */
function connectionScheme(req: Request): 'http' | 'https' {
  const socket = req.socket as { encrypted?: boolean } | undefined;
  if (socket?.encrypted) return 'https';
  // Fallback for mocked requests without a socket.
  return socket ? 'http' : (validScheme(req.protocol) ?? 'http');
}

/**
 * Public origin (`https://host[:port]`) for absolute URLs.
 *
 * 1. `settings.aiAccess.publicBaseUrl` when configured (overrides everything).
 * 2. When Express `trust proxy` is set: the first `X-Forwarded-Proto` value if
 *    it is exactly http/https, else the connection scheme; the first
 *    `X-Forwarded-Host` value if it passes {@link isValidHostHeader}, else
 *    `Host`.
 * 3. Otherwise `Host` + connection scheme — `X-Forwarded-*` is ignored so an
 *    untrusted client cannot spoof link origins.
 *
 * `Host` is validated the same way. Returns undefined (callers fall back to a
 * relative path) when no valid host is available.
 */
export function requestPublicOrigin(req: Request): string | undefined {
  if (configuredPublicBaseUrl) {
    return configuredPublicBaseUrl;
  }
  const trust = isTrustProxyEnabled(req);
  const forwardedHost = trust ? firstForwardedValue(req, 'x-forwarded-host') : undefined;
  const hostHeader = req.get('host')?.trim();
  const host = isValidHostHeader(forwardedHost)
    ? forwardedHost
    : isValidHostHeader(hostHeader)
      ? hostHeader
      : undefined;
  if (!host) {
    return undefined;
  }
  const scheme =
    (trust ? validScheme(firstForwardedValue(req, 'x-forwarded-proto')) : undefined) ??
    connectionScheme(req);
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return undefined;
  }
}

/** Join origin + path, or return path alone when origin is unknown. */
export function absolutizePath(req: Request, path: string): string {
  const origin = requestPublicOrigin(req);
  return origin ? `${origin}${path}` : path;
}

/**
 * Build a shareable absolute URL for an access link from the creating request.
 * Falls back to a root-relative path when Host is unavailable.
 * Honors `publicBaseUrl`, then `X-Forwarded-*` only when Express `trust proxy` is enabled.
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
