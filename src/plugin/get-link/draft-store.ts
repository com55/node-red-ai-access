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

export class DraftStore {
  private readonly drafts = new Map<string, DraftRecord>();
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
    this.drafts.set(id, record);
    return record;
  }

  getForLink(draftId: string, linkId: string): DraftRecord {
    const atMs = this.now();
    this.purgeExpired(atMs);
    const draft = this.drafts.get(draftId);
    if (draft?.linkId !== linkId) {
      throw new DraftNotFoundError(draftId);
    }
    if (draft.expiresAtMs <= atMs) {
      throw new DraftNotFoundError(draftId);
    }
    return draft;
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
      let decodedLen: number;
      try {
        decodedLen = Buffer.from(data, 'base64url').byteLength;
      } catch {
        throw new DraftValidationError('data must be a base64url string', 'invalid_chunk');
      }
      const nextBytes = draft.totalBytes + decodedLen;
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
    const buffers = parts.map(part => {
      try {
        return Buffer.from(part, 'base64url');
      } catch {
        throw new DraftValidationError('Chunk is not valid base64url', 'invalid_chunk');
      }
    });
    const assembledBuf = Buffer.concat(buffers);
    if (assembledBuf.byteLength > this.maxBytes) {
      throw new DraftValidationError(
        `Assembled draft exceeds limit of ${this.maxBytes} bytes`,
        'payload_too_large'
      );
    }

    const digest = createHash('sha256').update(assembledBuf).digest('hex');
    const expected = sha256Hex.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected) || digest !== expected) {
      throw new DraftValidationError(
        'sha256 does not match assembled draft content',
        'draft_hash_mismatch'
      );
    }

    this.drafts.delete(draftId);
    return { draft, assembled: assembledBuf.toString('utf8') };
  }

  /** Test helper. */
  size(): number {
    this.purgeExpired(this.now());
    return this.drafts.size;
  }

  clear(): void {
    this.drafts.clear();
  }
}
