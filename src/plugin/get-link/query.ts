/**
 * Shared query-string helpers for GET access-link routes.
 */

import type { AuthenticatedRequest } from '../types.js';

export function queryString(query: AuthenticatedRequest['query'], key: string): string | undefined {
  const value = query[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
    return value[0];
  }
  return undefined;
}
