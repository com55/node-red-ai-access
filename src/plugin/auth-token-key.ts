/**
 * Match Node-RED editor localStorage key for auth tokens.
 *
 * Editor (`RED.settings.init`): path = pathname.slice(0,-1), suffix = path
 * with `/` → `-`, key = `auth-tokens` + suffix.
 */

import { normalizeHttpAdminRoot } from './auth.js';

/** localStorage key the editor uses for `{ access_token }` under httpAdminRoot. */
export function editorAuthTokenKey(httpAdminRoot: string | undefined): string {
  const root = normalizeHttpAdminRoot(httpAdminRoot);
  // Editor at `/` → pathname `/` → slice(0,-1) → `` → suffix ``
  // Editor at `/admin/` → pathname `/admin/` → slice → `/admin` → `-admin`
  const path = root === '/' ? '' : root;
  const suffix = path.replace(/\//g, '-');
  return `auth-tokens${suffix}`;
}
