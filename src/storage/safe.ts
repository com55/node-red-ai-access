/**
 * Path and content sanitizers for on-disk AI Access storage (CodeQL).
 */

import { basename, resolve, sep } from 'node:path';

/** Single path segment: alphanumeric, dash, underscore, dot (no `/`, no `..`). */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/** Proposal ids we mint: `prop-` + hex (or test doubles using the same charset). */
const SAFE_PROPOSAL_ID_RE = /^prop-[A-Za-z0-9_-]+$/;

/** Top-level FlowTab fields we persist (nodes/configs handled separately). */
const FLOW_TAB_KEYS = ['id', 'type', 'label', 'disabled', 'info', 'env'] as const;

/** Audit detail keys we persist. */
const AUDIT_DETAIL_KEYS = [
  'proposalId',
  'flowId',
  'expectedRev',
  'resultRev',
  'reason',
  'code',
  'currentRev',
] as const;

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

function sanitizeString(value: unknown, max = 100_000): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.replace(/\0/g, '').slice(0, max);
}

/**
 * Copy a flow tab using fixed key names only (avoids remote property injection).
 * Node/config objects are size-capped via JSON round-trip.
 */
export function sanitizeFlowTab(value: unknown): Record<string, unknown> {
  const src =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const out: Record<string, unknown> = {};
  for (const key of FLOW_TAB_KEYS) {
    if (!(key in src)) {
      continue;
    }
    const nested = src[key];
    if (key === 'disabled' && typeof nested === 'boolean') {
      out[key] = nested;
      continue;
    }
    if (key === 'env' && Array.isArray(nested)) {
      const encoded = JSON.stringify(nested);
      if (encoded.length <= 500_000) {
        out[key] = JSON.parse(encoded) as unknown[];
      }
      continue;
    }
    const asString = sanitizeString(nested, 10_000);
    if (asString !== undefined) {
      out[key] = asString;
    }
  }

  for (const listKey of ['nodes', 'configs'] as const) {
    const list = src[listKey];
    if (!Array.isArray(list)) {
      continue;
    }
    const encoded = JSON.stringify(list.slice(0, 5_000));
    if (encoded.length > 1_500_000) {
      continue;
    }
    out[listKey] = JSON.parse(encoded) as unknown[];
  }

  return out;
}

/** Copy only known audit detail fields with fixed key names. */
export function sanitizeAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of AUDIT_DETAIL_KEYS) {
    if (!(key in details)) {
      continue;
    }
    const asString = sanitizeString(details[key], 2_000);
    if (asString !== undefined) {
      out[key] = asString;
    }
  }
  return out;
}
