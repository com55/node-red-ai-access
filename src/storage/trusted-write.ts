/**
 * Trusted disk writes for `.ai-access` — only sanitized records, fixed roots,
 * size-capped payloads, and restrictive file modes.
 */

import { appendFileSync, chmodSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** Directory mode for `.ai-access` and children. */
export const AI_ACCESS_DIR_MODE = 0o700;

/** File mode for proposal JSON and audit log files. */
export const AI_ACCESS_FILE_MODE = 0o600;

/** Max serialized proposal JSON size (pretty-printed). */
export const MAX_PROPOSAL_JSON_BYTES = 1_500_000;

/** Max size of a single audit JSONL line (including trailing newline). */
export const MAX_AUDIT_APPEND_BYTES = 8_192;

export class StoragePayloadTooLargeError extends Error {
  readonly code = 'storage_payload_too_large' as const;
  readonly statusCode = 413;

  constructor(
    readonly kind: string,
    readonly size: number,
    readonly maxBytes: number
  ) {
    super(`${kind} size ${size} bytes exceeds limit of ${maxBytes} bytes`);
    this.name = 'StoragePayloadTooLargeError';
  }
}

/**
 * Opaque UTF-8 payload produced only via {@link encodeTrustedJson} from
 * already-sanitized records (never raw request bodies).
 */
export interface TrustedStoragePayload {
  readonly bytes: Buffer;
}

export interface EncodeTrustedJsonOptions {
  /** Human-readable kind used in size-limit errors (e.g. "proposal", "audit"). */
  kind: string;
  /** Pretty-print JSON (proposal files). Default compact. */
  pretty?: boolean;
}

/**
 * Serialize a sanitized record and enforce a byte size cap.
 */
export function encodeTrustedJson(
  record: object,
  maxBytes: number,
  options: EncodeTrustedJsonOptions
): TrustedStoragePayload {
  const text = options.pretty
    ? `${JSON.stringify(record, null, 2)}\n`
    : `${JSON.stringify(record)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength > maxBytes) {
    throw new StoragePayloadTooLargeError(options.kind, bytes.byteLength, maxBytes);
  }
  return { bytes };
}

/**
 * Ensure `absolutePath` resolves under `storageRoot` (the `.ai-access` root).
 */
export function assertUnderAiAccess(absolutePath: string, storageRoot: string): string {
  const root = resolve(storageRoot);
  const target = resolve(absolutePath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('Path escapes .ai-access storage root');
  }
  return target;
}

/**
 * Atomically replace a file under `.ai-access` with mode {@link AI_ACCESS_FILE_MODE}.
 */
export function writeTrustedAtomic(
  storageRoot: string,
  targetPath: string,
  payload: TrustedStoragePayload
): void {
  const target = assertUnderAiAccess(targetPath, storageRoot);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, payload.bytes, { mode: AI_ACCESS_FILE_MODE });
  renameSync(temp, target);
  chmodSync(target, AI_ACCESS_FILE_MODE);
}

/**
 * Append a trusted JSONL line under `.ai-access` with mode {@link AI_ACCESS_FILE_MODE}.
 */
export function appendTrusted(
  storageRoot: string,
  filePath: string,
  payload: TrustedStoragePayload
): void {
  const target = assertUnderAiAccess(filePath, storageRoot);
  appendFileSync(target, payload.bytes, { mode: AI_ACCESS_FILE_MODE });
  try {
    chmodSync(target, AI_ACCESS_FILE_MODE);
  } catch {
    // Best-effort when the filesystem ignores chmod (e.g. some CI mounts).
  }
}
