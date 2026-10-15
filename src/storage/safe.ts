/**
 * Path and content sanitizers for on-disk AI Access storage (CodeQL).
 */

import { basename, resolve, sep } from 'node:path';

/** Single path segment: alphanumeric, dash, underscore, dot (no `/`, no `..`). */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/** Proposal ids we mint: `prop-` + hex (or test doubles using the same charset). */
const SAFE_PROPOSAL_ID_RE = /^prop-[A-Za-z0-9_-]+$/;

export function assertSafeSegment(value: string, paramName: string): string {
  if (!value || !SAFE_SEGMENT_RE.test(value) || value.includes('..')) {
    throw new Error(`Invalid ${paramName}`);
  }
  return value;
}

export function assertSafeProposalId(id: string): string {
  if (!id || !SAFE_PROPOSAL_ID_RE.test(id) || id.includes('..')) {
    throw new Error(`Invalid proposal id`);
  }
  return id;
}

/**
 * Resolve `fileName` under `dir`, rejecting traversal outside `dir`.
 */
export function resolveUnderDir(dir: string, fileName: string): string {
  const safeName = basename(fileName);
  if (!safeName || safeName !== fileName || safeName.includes('..')) {
    throw new Error('Invalid file name');
  }
  const root = resolve(dir);
  const target = resolve(root, safeName);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('Path escapes storage directory');
  }
  return target;
}

/**
 * Copy a plain JSON value with length caps so disk writes do not keep a
 * remote-taint edge on arbitrary nested payloads.
 */
export function sanitizeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 20) {
    return null;
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    return value.replace(/\0/g, '').slice(0, 100_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 5_000).map(item => sanitizeJsonValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (count >= 500) {
        break;
      }
      const safeKey = String(key).replace(/\0/g, '').slice(0, 200);
      if (!safeKey) {
        continue;
      }
      out[safeKey] = sanitizeJsonValue(nested, depth + 1);
      count += 1;
    }
    return out;
  }
  return null;
}
