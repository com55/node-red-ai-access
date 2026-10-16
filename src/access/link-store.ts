/**
 * In-memory access-link store. Nothing is persisted — a process restart
 * clears every link, so previously issued tokens become invalid.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  AccessLinkLimitError,
  AccessLinkNotFoundError,
  AccessLinkValidationError,
} from './errors.js';

export interface AccessLinkPublic {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
  /** ISO time of last successful token validation; omitted until first use. */
  lastUsedAt?: string;
  createdBy?: string;
}

export interface AccessLinkCreated extends AccessLinkPublic {
  /** Raw token — available while the in-memory link is active. */
  token: string;
}

export interface AccessLinkRecord {
  id: string;
  tokenHash: string;
  /** Raw token kept in memory so admins can re-copy the GET URL. */
  token: string;
  label?: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastUsedAtMs?: number;
  createdBy?: string;
  revokedAtMs?: number;
}

export interface CreateAccessLinkInput {
  ttlSeconds?: number;
  label?: string;
  createdBy?: string;
}

export interface AccessLinkStoreOptions {
  /** Defaults to 14400 (4h). */
  defaultTtlSeconds?: number;
  /** Defaults to 10. */
  maxActiveLinks?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable id/token generators for tests. */
  randomId?: () => string;
  randomToken?: () => string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function toPublic(record: AccessLinkRecord): AccessLinkPublic {
  const publicLink: AccessLinkPublic = {
    id: record.id,
    createdAt: new Date(record.createdAtMs).toISOString(),
    expiresAt: new Date(record.expiresAtMs).toISOString(),
  };
  if (record.label !== undefined) {
    publicLink.label = record.label;
  }
  if (record.lastUsedAtMs !== undefined) {
    publicLink.lastUsedAt = new Date(record.lastUsedAtMs).toISOString();
  }
  if (record.createdBy !== undefined) {
    publicLink.createdBy = record.createdBy;
  }
  return publicLink;
}

export class AccessLinkStore {
  private readonly links = new Map<string, AccessLinkRecord>();
  private defaultTtlSeconds: number;
  private maxActiveLinks: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly randomToken: () => string;

  constructor(options: AccessLinkStoreOptions = {}) {
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 14_400;
    this.maxActiveLinks = options.maxActiveLinks ?? 10;
    this.now = options.now ?? (() => Date.now());
    this.randomId = options.randomId ?? (() => randomBytes(12).toString('hex'));
    this.randomToken =
      options.randomToken ?? (() => `aia_${randomBytes(32).toString('base64url')}`);
  }

  /** Hot-update defaults from AI Access settings (no restart). */
  configureDefaults(options: { defaultTtlSeconds?: number; maxActiveLinks?: number }): void {
    if (
      typeof options.defaultTtlSeconds === 'number' &&
      Number.isFinite(options.defaultTtlSeconds) &&
      options.defaultTtlSeconds > 0
    ) {
      this.defaultTtlSeconds = Math.floor(options.defaultTtlSeconds);
    }
    if (
      typeof options.maxActiveLinks === 'number' &&
      Number.isFinite(options.maxActiveLinks) &&
      options.maxActiveLinks > 0
    ) {
      this.maxActiveLinks = Math.floor(options.maxActiveLinks);
    }
  }

  /** Active = not revoked and not past expiresAt. */
  private isActive(record: AccessLinkRecord, atMs: number): boolean {
    if (record.revokedAtMs !== undefined) {
      return false;
    }
    return record.expiresAtMs > atMs;
  }

  list(): AccessLinkPublic[] {
    const atMs = this.now();
    return [...this.links.values()]
      .filter(record => this.isActive(record, atMs))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map(toPublic);
  }

  create(input: CreateAccessLinkInput = {}): AccessLinkCreated {
    const atMs = this.now();
    const activeCount = [...this.links.values()].filter(record =>
      this.isActive(record, atMs)
    ).length;
    if (activeCount >= this.maxActiveLinks) {
      throw new AccessLinkLimitError(this.maxActiveLinks);
    }

    let ttlSeconds = this.defaultTtlSeconds;
    if (input.ttlSeconds !== undefined) {
      if (
        typeof input.ttlSeconds !== 'number' ||
        !Number.isFinite(input.ttlSeconds) ||
        input.ttlSeconds <= 0
      ) {
        throw new AccessLinkValidationError('ttlSeconds must be a positive number');
      }
      ttlSeconds = Math.floor(input.ttlSeconds);
    }

    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : undefined;

    const id = this.randomId();
    const token = this.randomToken();
    const record: AccessLinkRecord = {
      id,
      tokenHash: hashToken(token),
      token,
      createdAtMs: atMs,
      expiresAtMs: atMs + ttlSeconds * 1000,
    };
    if (label !== undefined) {
      record.label = label;
    }
    if (input.createdBy !== undefined) {
      record.createdBy = input.createdBy;
    }

    this.links.set(id, record);

    return {
      ...toPublic(record),
      token,
    };
  }

  /**
   * Raw token for an active link (in-memory only). Used to rebuild the GET URL
   * for admin "Copy link" — never logs the value.
   */
  peekToken(linkId: string): string | null {
    const record = this.links.get(linkId);
    if (!record || !this.isActive(record, this.now())) {
      return null;
    }
    return record.token;
  }

  revoke(linkId: string): AccessLinkPublic {
    const record = this.links.get(linkId);
    if (!record) {
      throw new AccessLinkNotFoundError(linkId);
    }
    record.revokedAtMs ??= this.now();
    return toPublic(record);
  }

  /**
   * Look up a link by id even if revoked/expired (still in memory).
   * Used to enrich older audit rows that omitted label/expiry.
   */
  getById(linkId: string): AccessLinkPublic | null {
    if (typeof linkId !== 'string' || linkId.length === 0) {
      return null;
    }
    const record = this.links.get(linkId);
    if (!record) {
      return null;
    }
    return toPublic(record);
  }

  /**
   * Validate a raw bearer token. Returns the public link metadata when valid;
   * otherwise null (unknown / expired / revoked / pre-restart).
   */
  validate(token: string): AccessLinkPublic | null {
    if (typeof token !== 'string' || token.length === 0) {
      return null;
    }

    const tokenHash = hashToken(token);
    const atMs = this.now();

    for (const record of this.links.values()) {
      if (!hashesEqual(record.tokenHash, tokenHash)) {
        continue;
      }
      if (!this.isActive(record, atMs)) {
        return null;
      }
      record.lastUsedAtMs = atMs;
      return toPublic(record);
    }

    return null;
  }

  /** Test helper: number of records still held in memory (including revoked). */
  size(): number {
    return this.links.size;
  }

  /** Test helper: wipe everything (simulates a process restart). */
  clear(): void {
    this.links.clear();
  }
}
