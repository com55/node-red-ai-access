/**
 * Package version injected at build time (tsup / vitest `define`).
 * Used for status payloads and editor-sidebar asset cache-busting.
 */

declare const __AI_ACCESS_VERSION__: string | undefined;

let cachedVersion: string | undefined;

/** Resolved package version (`package.json` via build define). */
export function packageVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  if (typeof __AI_ACCESS_VERSION__ === 'string' && __AI_ACCESS_VERSION__.length > 0) {
    cachedVersion = __AI_ACCESS_VERSION__;
    return cachedVersion;
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
}
