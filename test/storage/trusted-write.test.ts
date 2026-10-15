/**
 * Trusted write helper, directory/file modes, and size-cap tests.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../../src/storage/audit-log.js';
import { ensureAiAccessDirs, resolveAiAccessPaths } from '../../src/storage/paths.js';
import { ProposalStore } from '../../src/storage/proposals.js';
import {
  AI_ACCESS_DIR_MODE,
  AI_ACCESS_FILE_MODE,
  MAX_AUDIT_APPEND_BYTES,
  MAX_PROPOSAL_JSON_BYTES,
  StoragePayloadTooLargeError,
  appendTrusted,
  assertUnderAiAccess,
  encodeTrustedJson,
  writeTrustedAtomic,
} from '../../src/storage/trusted-write.js';

describe('trusted-write helper', () => {
  let root: string;
  let storageRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ai-access-tw-'));
    const paths = resolveAiAccessPaths(root);
    ensureAiAccessDirs(paths);
    storageRoot = paths.root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes atomic JSON under .ai-access with mode 0o600', () => {
    const target = join(storageRoot, 'proposals', 'prop-test.json');
    const payload = encodeTrustedJson({ id: 'prop-test', ok: true }, MAX_PROPOSAL_JSON_BYTES, {
      pretty: true,
      kind: 'proposal',
    });
    writeTrustedAtomic(storageRoot, target, payload);

    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(AI_ACCESS_FILE_MODE);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ id: 'prop-test', ok: true });
  });

  it('appends trusted bytes with mode 0o600', () => {
    const target = join(storageRoot, 'logs', 'audit.jsonl');
    const payload = encodeTrustedJson({ action: 'proposal.created' }, MAX_AUDIT_APPEND_BYTES, {
      kind: 'audit',
    });
    appendTrusted(storageRoot, target, payload);

    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(AI_ACCESS_FILE_MODE);
    expect(readFileSync(target, 'utf8')).toContain('proposal.created');
  });

  it('rejects paths that escape the storage root', () => {
    expect(() => assertUnderAiAccess('/tmp/evil.json', storageRoot)).toThrow(/escapes/i);
  });

  it('rejects oversized trusted payloads', () => {
    expect(() => encodeTrustedJson({ blob: 'x'.repeat(200) }, 50, { kind: 'audit' })).toThrow(
      StoragePayloadTooLargeError
    );
  });
});

describe('storage directory modes', () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates .ai-access directories with mode 0o700', () => {
    root = mkdtempSync(join(tmpdir(), 'ai-access-dirs-'));
    const paths = resolveAiAccessPaths(root);
    ensureAiAccessDirs(paths);

    expect(statSync(paths.root).mode & 0o777).toBe(AI_ACCESS_DIR_MODE);
    expect(statSync(paths.proposals).mode & 0o777).toBe(AI_ACCESS_DIR_MODE);
    expect(statSync(paths.logs).mode & 0o777).toBe(AI_ACCESS_DIR_MODE);
  });
});

describe('proposal and audit size caps', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ai-access-size-'));
    const paths = resolveAiAccessPaths(root);
    ensureAiAccessDirs(paths);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('throws a clear error when proposal JSON exceeds the max size', () => {
    const paths = resolveAiAccessPaths(root);
    const store = new ProposalStore(paths, {
      randomId: () => 'abc',
      maxProposalBytes: 120,
    });

    expect(() =>
      store.create({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: {
          flowId: 'tab-1',
          flow: { label: 'x'.repeat(200), nodes: [] },
        },
        createdBy: { kind: 'access-link', linkId: 'link1' },
      })
    ).toThrow(StoragePayloadTooLargeError);

    try {
      store.create({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: {
          flowId: 'tab-1',
          flow: { label: 'x'.repeat(200), nodes: [] },
        },
        createdBy: { kind: 'access-link', linkId: 'link1' },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(StoragePayloadTooLargeError);
      const err = error as StoragePayloadTooLargeError;
      expect(err.statusCode).toBe(413);
      expect(err.code).toBe('storage_payload_too_large');
      expect(err.message).toMatch(/proposal/i);
      expect(err.message).toMatch(/exceeds/i);
    }
  });

  it('throws a clear error when an audit append exceeds the max size', () => {
    const paths = resolveAiAccessPaths(root);
    const audit = new AuditLog(paths, { maxAppendBytes: 80 });

    expect(() =>
      audit.append(
        'proposal.created',
        { kind: 'admin', username: 'a'.repeat(200) },
        {
          reason: 'b'.repeat(200),
        }
      )
    ).toThrow(StoragePayloadTooLargeError);

    try {
      audit.append(
        'proposal.created',
        { kind: 'admin', username: 'a'.repeat(200) },
        {
          reason: 'b'.repeat(200),
        }
      );
    } catch (error) {
      const err = error as StoragePayloadTooLargeError;
      expect(err.statusCode).toBe(413);
      expect(err.message).toMatch(/audit/i);
    }
  });
});
