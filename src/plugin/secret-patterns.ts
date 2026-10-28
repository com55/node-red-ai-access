/**
 * Secret name pattern defaults and normalization (leaf module: imported by the
 * settings store and by secret-redaction without an import cycle).
 */

export const REDACTED_PLACEHOLDER = '[REDACTED]';

/** Default case-insensitive secret name patterns (matched on word tokens). */
export const DEFAULT_SECRET_NAME_PATTERNS: readonly string[] = Object.freeze([
  'PASSWORD',
  'PASSWD',
  'PASS',
  'PWD',
  'PW',
  'PASSPHRASE',
  'SECRET',
  'CLIENT_SECRET',
  'TOKEN',
  'API_KEY',
  'APIKEY',
  'KEY',
  'PRIVATE',
  'CREDENTIAL',
  'AUTH',
  'AUTHORIZATION',
  'BEARER',
  'SESSION',
  'COOKIE',
  'CONNECTION_STRING',
  'CONN_STR',
  'CONN',
  'DSN',
]);

/** Valid pattern: letters, digits, `_` / `-`, 2–40 chars. */
export const SECRET_NAME_PATTERN_RE = /^[A-Za-z0-9_-]{2,40}$/;
export const MAX_SECRET_NAME_PATTERNS = 100;

export function tokenizeName(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(t => t.toUpperCase());
}

/** Normalize a user-supplied pattern list (trim, uppercase, dedupe, validate). */
export function normalizeSecretNamePatterns(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const value = entry.trim().toUpperCase();
    if (!SECRET_NAME_PATTERN_RE.test(value) || out.includes(value)) continue;
    out.push(value);
    if (out.length >= MAX_SECRET_NAME_PATTERNS) break;
  }
  return out;
}
