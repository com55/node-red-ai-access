/**
 * Error registry: generated docs stay fresh (CI staleness check) and required
 * codes are registered. Set UPDATE_ERRORS=1 to rewrite the generated docs.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  applyOpenApiErrorCodes,
  ERROR_REGISTRY,
  errorSpec,
  renderErrorsMarkdown,
  registryHint,
  renderGetLinkErrorTable,
} from '../../src/plugin/error-registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ERRORS_MD = join(ROOT, 'docs/errors.md');
const OPENAPI = join(ROOT, 'docs/api/openapi.yaml');
const UPDATE = process.env.UPDATE_ERRORS === '1';

describe('error registry', () => {
  it('docs/errors.md matches the registry (or updates when UPDATE_ERRORS=1)', () => {
    const generated = renderErrorsMarkdown();
    if (UPDATE) {
      writeFileSync(ERRORS_MD, generated, 'utf8');
    }
    expect(readFileSync(ERRORS_MD, 'utf8')).toBe(generated);
  });

  it('OpenAPI ErrorCode block matches the registry (or updates when UPDATE_ERRORS=1)', () => {
    const onDisk = readFileSync(OPENAPI, 'utf8');
    const generated = applyOpenApiErrorCodes(onDisk);
    if (UPDATE) {
      writeFileSync(OPENAPI, generated, 'utf8');
    }
    expect(readFileSync(OPENAPI, 'utf8')).toBe(generated);
  });

  it('has unique codes with status, meaning, and hint', () => {
    const codes = ERROR_REGISTRY.map(s => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const spec of ERROR_REGISTRY) {
      expect(spec.status).toBeGreaterThanOrEqual(200);
      expect(spec.meaning.length).toBeGreaterThan(0);
      expect(spec.hint.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['deploy_timeout', 504, 'error'],
    ['approve_queue_timeout', 504, 'error'],
    ['secret_may_revert', 200, 'warning'],
    ['confirm_required', 400, 'error'],
    ['missing_expected_rev', 400, 'error'],
    ['missing_node_type', 400, 'error'],
    ['invalid_diff_format', 400, 'error'],
    ['unsupported_media_type', 415, 'error'],
    ['invalid_wires', 400, 'error'],
    ['missing_config_node', 201, 'warning'],
    ['superseded', 200, 'status'],
    ['expired', 200, 'status'],
    ['invalid_filter', 400, 'error'],
    ['invalid_ttl', 400, 'error'],
    ['duplicate_node_id', 400, 'error'],
    ['validation_failed', 400, 'error'],
    ['token_expired', 401, 'error'],
  ])('registers %s', (code, status, kind) => {
    const spec = errorSpec(code);
    expect(spec).toBeDefined();
    expect(spec?.status).toBe(status);
    expect(spec?.kind).toBe(kind);
  });

  it('invalid_ttl hint states the per-kind caps', () => {
    expect(errorSpec('invalid_ttl')?.hint).toMatch(/get_link.*24h.*rest and mcp.*30 days/);
  });

  it('GET guide tables cover every code, warnings, statuses, and autoClosedCount', () => {
    const table = renderGetLinkErrorTable();
    for (const code of [
      'token_expired',
      'confirm_required',
      'invalid_ttl',
      'unsupported_media_type',
      'missing_config_node',
      'superseded',
      'expired',
      'duplicate_node_id',
    ]) {
      expect(table).toContain(`\`${code}\``);
    }
    expect(table).toMatch(/autoClosedCount/);
    expect(table).toMatch(/\| Channels \|/);
  });

  it('every registered code has a hint used as the cross-channel fallback', () => {
    expect(registryHint('node_already_exists')).toBeTruthy();
    expect(registryHint('validation_failed')).toMatch(/errors\[\]/);
  });
});
