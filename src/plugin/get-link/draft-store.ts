/**
 * In-memory chunked drafts for GET-only access links.
 * Lost on restart; expire after DRAFT_TTL_MS.
 */

import { createHash, randomBytes } from 'node:crypto';

import { MAX_PROPOSAL_JSON_BYTES } from '../../storage/trusted-write.js';
import { DRAFT_TTL_MS } from '../access-path.js';

export type DraftMode = 'field' | 'json';

export interface DraftTarget {
  nodeId: string;
  field: string;
}

export interface DraftRecord {
  id: string;
  linkId: string;
  flowId: string;
  expectedRev: string;
  mode: DraftMode;
  /** Single-field mode. */
  nodeId?: string;
  field?: string;
  /** Optional multi field targets (simple). */
  targets?: DraftTarget[];
  summary?: string;
  /** Optional proposal title carried through to submit. */
  title?: string;
  chunks: Map<number, string>;
  createdAtMs: number;
  expiresAtMs: number;
  totalBytes: number;
}

export interface CreateDraftInput {
  linkId: string;
  flowId: string;
  expectedRev: string;
  mode: DraftMode;
  nodeId?: string;
  field?: string;
  targets?: DraftTarget[];
  summary?: string;
  title?: string;
}

export class DraftValidationError extends Error {
  readonly statusCode = 400;
  readonly code: string;
  constructor(message: string, code = 'draft_invalid') {
    super(message);
    this.name = 'DraftValidationError';
    this.code = code;
  }
}

export class DraftNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'draft_not_found' as const;
  constructor(id: string) {
    super(`Draft '${id}' was not found or has expired`);
    this.name = 'DraftNotFoundError';
  }
}

export class DraftAlreadySubmittedError extends Error {
  readonly statusCode = 409;
  readonly code = 'draft_already_submitted' as const;
  readonly proposalId: string;
  constructor(draftId: string, proposalId: string) {
    super(`Draft '${draftId}' was already submitted as proposal '${proposalId}'`);
    this.name = 'DraftAlreadySubmittedError';
    this.proposalId = proposalId;
  }
}

/** Strict base64url alphabet (optional padding). */
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

function assertValidBase64UrlChunk(data: string): Buffer {
  if (!BASE64URL_RE.test(data) || data.replace(/=+$/, '').length === 0) {
    throw new DraftValidationError(
      'data must be non-empty base64url (A-Z, a-z, 0-9, -, _)',
      'invalid_chunk_data'
    );
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(data, 'base64url');
  } catch {
    throw new DraftValidationError(
      'data must be non-empty base64url (A-Z, a-z, 0-9, -, _)',
      'invalid_chunk_data'
    );
  }
  // Reject alphabets that decode to empty (e.g. invalid chars stripped by Buffer).
  if (decoded.byteLength === 0 && data.length > 0) {
    throw new DraftValidationError(
      'data must be non-empty base64url (A-Z, a-z, 0-9, -, _)',
      'invalid_chunk_data'
    );
  }
  return decoded;
}

export class DraftStore {
  private readonly drafts = new Map<string, DraftRecord>();
  /** Tombstones for drafts that already produced a proposal (same TTL window). */
  private readonly submitted = new Map<
    string,
    { linkId: string; proposalId: string; expiresAtMs: number }
  >();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly maxBytes: number;
  private readonly ttlMs: number;

  constructor(
    options: {
      now?: () => number;
      randomId?: () => string;
      maxBytes?: number;
      ttlMs?: number;
    } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.randomId = options.randomId ?? (() => randomBytes(12).toString('hex'));
    this.maxBytes = options.maxBytes ?? MAX_PROPOSAL_JSON_BYTES;
    this.ttlMs = options.ttlMs ?? DRAFT_TTL_MS;
  }

  private purgeExpired(atMs: number): void {
    for (const [id, draft] of this.drafts) {
      if (draft.expiresAtMs <= atMs) {
        this.drafts.delete(id);
      }
    }
    for (const [id, entry] of this.submitted) {
      if (entry.expiresAtMs <= atMs) {
        this.submitted.delete(id);
      }
    }
  }

  create(input: CreateDraftInput): DraftRecord {
    const atMs = this.now();
    this.purgeExpired(atMs);
    const id = this.randomId();
    const record: DraftRecord = {
      id,
      linkId: input.linkId,
      flowId: input.flowId,
      expectedRev: input.expectedRev,
      mode: input.mode,
      chunks: new Map(),
      createdAtMs: atMs,
      expiresAtMs: atMs + this.ttlMs,
      totalBytes: 0,
    };
    if (input.nodeId !== undefined) record.nodeId = input.nodeId;
    if (input.field !== undefined) record.field = input.field;
    if (input.targets !== undefined) record.targets = input.targets;
    if (input.summary !== undefined) record.summary = input.summary;
    if (input.title !== undefined) record.title = input.title;
    this.drafts.set(id, record);
    return record;
  }

  getForLink(draftId: string, linkId: string): DraftRecord {
    const atMs = this.now();
    this.purgeExpired(atMs);
    const done = this.submitted.get(draftId);
    if (done?.linkId === linkId) {
      throw new DraftAlreadySubmittedError(draftId, done.proposalId);
    }
    const draft = this.drafts.get(draftId);
    if (draft?.linkId !== linkId) {
      throw new DraftNotFoundError(draftId);
    }
    if (draft.expiresAtMs <= atMs) {
      throw new DraftNotFoundError(draftId);
    }
    return draft;
  }

  /** Record a successful submit so re-submit returns draft_already_submitted. */
  markSubmitted(draftId: string, linkId: string, proposalId: string): void {
    const atMs = this.now();
    this.drafts.delete(draftId);
    this.submitted.set(draftId, {
      linkId,
      proposalId,
      expiresAtMs: atMs + this.ttlMs,
    });
  }

  /**
   * Idempotent per seq: re-sending the same seq+data is OK; conflicting data
   * for an existing seq is rejected.
   */
  append(
    draftId: string,
    linkId: string,
    seq: number,
    data: string
  ): {
    draft: DraftRecord;
    receivedSeqs: number[];
    missingSeqs: number[];
    /** Decoded UTF-8 / binary bytes across all chunks (not base64url length). */
    totalBytes: number;
    maxBytes: number;
  } {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new DraftValidationError('seq must be a non-negative integer', 'invalid_seq');
    }
    if (typeof data !== 'string') {
      throw new DraftValidationError('data must be a base64url string', 'invalid_chunk');
    }

    const draft = this.getForLink(draftId, linkId);
    const existing = draft.chunks.get(seq);
    if (existing !== undefined) {
      if (existing !== data) {
        throw new DraftValidationError(
          `Chunk seq ${seq} already stored with different data`,
          'chunk_conflict'
        );
      }
    } else {
      // Count decoded payload bytes (not base64url character length).
      const decoded = assertValidBase64UrlChunk(data);
      const nextBytes = draft.totalBytes + decoded.byteLength;
      if (nextBytes > this.maxBytes) {
        throw new DraftValidationError(
          `Draft exceeds limit of ${this.maxBytes} bytes (decoded)`,
          'payload_too_large'
        );
      }
      draft.chunks.set(seq, data);
      draft.totalBytes = nextBytes;
    }

    const receivedSeqs = [...draft.chunks.keys()].sort((a, b) => a - b);
    const missingSeqs: number[] = [];
    const maxSeq = receivedSeqs.at(-1);
    if (maxSeq !== undefined) {
      for (let i = 0; i <= maxSeq; i += 1) {
        if (!draft.chunks.has(i)) {
          missingSeqs.push(i);
        }
      }
    }

    return {
      draft,
      receivedSeqs,
      missingSeqs,
      totalBytes: draft.totalBytes,
      maxBytes: this.maxBytes,
    };
  }

  /** Expose the configured decoded-byte cap (for append responses). */
  getMaxBytes(): number {
    return this.maxBytes;
  }

  /**
   * Assemble chunks 0..N contiguous, verify sha256 of assembled UTF-8 bytes,
   * remove draft on success.
   */
  assembleAndVerify(
    draftId: string,
    linkId: string,
    sha256Hex: string
  ): {
    draft: DraftRecord;
    assembled: string;
  } {
    const draft = this.getForLink(draftId, linkId);
    if (draft.chunks.size === 0) {
      throw new DraftValidationError('Draft has no chunks', 'draft_empty');
    }

    const receivedSeqs = [...draft.chunks.keys()].sort((a, b) => a - b);
    const max = receivedSeqs.at(-1);
    if (max === undefined) {
      throw new DraftValidationError('Draft has no chunks', 'draft_empty');
    }
    const missing: number[] = [];
    for (let i = 0; i <= max; i += 1) {
      if (!draft.chunks.has(i)) {
        missing.push(i);
      }
    }
    if (missing.length > 0) {
      throw new DraftValidationError(`Missing chunk seqs: ${missing.join(',')}`, 'missing_chunks');
    }

    const parts: string[] = [];
    for (let i = 0; i <= max; i += 1) {
      const part = draft.chunks.get(i);
      if (part === undefined) {
        throw new DraftValidationError(`Missing chunk seqs: ${i}`, 'missing_chunks');
      }
      parts.push(part);
    }
    // Chunks are base64url payloads; decode each then concatenate bytes.
    const buffers = parts.map(part => assertValidBase64UrlChunk(part));
    const assembledBuf = Buffer.concat(buffers);
    if (assembledBuf.byteLength > this.maxBytes) {
      throw new DraftValidationError(
        `Assembled draft exceeds limit of ${this.maxBytes} bytes`,
        'payload_too_large'
      );
    }

    const expected = sha256Hex.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      throw new DraftValidationError('invalid_sha256: expected 64 hex chars', 'invalid_sha256');
    }
    const digest = createHash('sha256').update(assembledBuf).digest('hex');
    if (digest !== expected) {
      throw new DraftValidationError(
        'sha256 does not match assembled draft content',
        'draft_hash_mismatch'
      );
    }

    // Keep draft until markSubmitted so a failed propose can retry.
    return { draft, assembled: assembledBuf.toString('utf8') };
  }

  /** Test helper. */
  size(): number {
    this.purgeExpired(this.now());
    return this.drafts.size;
  }

  clear(): void {
    this.drafts.clear();
    this.submitted.clear();
  }
}
