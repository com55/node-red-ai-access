/**
 * Guard: Node-RED loads dist/plugin.cjs (not TypeScript sources).
 * A stale local dist after git pull can resurrect the removed "full access" chip
 * even though src/ and unit tests are correct — assert the built bundle.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const distPath = join(root, 'dist/plugin.cjs');

describe('built dist/plugin.cjs UI contracts', () => {
  it('is present after yarn build (CI builds before tests)', () => {
    expect(
      existsSync(distPath),
      'dist/plugin.cjs missing — run yarn build (Node-RED serves this file)'
    ).toBe(true);
  });

  it('has no legacy full-access status chip; Diagnostics Your role is present', () => {
    if (!existsSync(distPath)) return;
    const bundle = readFileSync(distPath, 'utf8');
    // Ban the Status chip label (not the unrelated "full access-link token" hint).
    expect(bundle).not.toMatch(/['"]full access['"]/);
    expect(bundle).not.toMatch(/id="status-badge"/);
    expect(bundle).not.toMatch(/modeLabel = s\.permission === '\*' \? 'full access'/);
    expect(bundle).toMatch(/id="status-role"/);
    expect(bundle).toMatch(/Your role/);
    expect(bundle).toMatch(/Admin \(can approve & manage links\)/);
    expect(bundle).toMatch(/buildDisambiguatedTitles/);
    expect(bundle).toMatch(/fmtClockHm/);
    expect(bundle).toMatch(/Enable MCP OAuth/);
    expect(bundle).toMatch(/Registered OAuth clients/);
    expect(bundle).toMatch(/OAuth route conflict/);
    expect(bundle).toMatch(/How to use MCP OAuth/);
    expect(bundle).toMatch(/Enable OAuth anyway/);
  });
});
