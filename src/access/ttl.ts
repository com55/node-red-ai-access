/**
 * Access-link TTL caps and helpers (shared by store, API, and UI docs).
 */

import type { AccessLinkKind } from './link-store.js';

/** Default TTL when create omits ttlSeconds (4 hours). */
export const DEFAULT_ACCESS_LINK_TTL_SECONDS = 14_400;

/** Max lifetime for get_link tokens (24 hours). */
export const MAX_TTL_SECONDS_GET_LINK = 24 * 60 * 60;

/** Max lifetime for rest / mcp tokens (30 days). */
export const MAX_TTL_SECONDS_REST_MCP = 30 * 24 * 60 * 60;

/** UI warns (red) when chosen duration is above this (24 hours). */
export const LONG_TTL_WARN_SECONDS = 24 * 60 * 60;

export function maxTtlSecondsForKind(kind: AccessLinkKind): number {
  return kind === 'get_link' ? MAX_TTL_SECONDS_GET_LINK : MAX_TTL_SECONDS_REST_MCP;
}

export function ttlCapErrorMessage(kind: AccessLinkKind, maxSeconds: number): string {
  if (kind === 'get_link') {
    return `get_link ttlSeconds must be ≤ ${maxSeconds} (24 hours)`;
  }
  return `ttlSeconds must be ≤ ${maxSeconds} (30 days) for ${kind} tokens`;
}

/** Hint for `invalid_ttl` errors — states the per-kind caps. */
export const INVALID_TTL_HINT =
  `ttlSeconds must be a positive number of seconds within the cap for the token kind: ` +
  `get_link ≤ ${MAX_TTL_SECONDS_GET_LINK} (24h); rest and mcp ≤ ${MAX_TTL_SECONDS_REST_MCP} (30 days).`;
