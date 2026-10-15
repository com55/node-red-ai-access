/**
 * SettingsStore merge + disk persistence.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureAiAccessDirs, resolveAiAccessPaths } from '../../src/storage/paths.js';
import { mergeAiAccessSettings, SettingsStore } from '../../src/storage/settings-store.js';

describe('mergeAiAccessSettings', () => {
  it('applies disk over settings.js over defaults', () => {
    const merged = mergeAiAccessSettings(
      { defaultLinkTtlSeconds: 3600, defaultDeploymentType: 'flows' },
      { defaultDeploymentType: 'full', enabled: false }
    );
    expect(merged.enabled).toBe(false);
    expect(merged.sources.enabled).toBe('disk');
    expect(merged.defaultLinkTtlSeconds).toBe(3600);
    expect(merged.sources.defaultLinkTtlSeconds).toBe('settings.js');
    expect(merged.defaultDeploymentType).toBe('full');
    expect(merged.sources.defaultDeploymentType).toBe('disk');
    expect(merged.allowWithoutAdminAuth).toBe(false);
    expect(merged.sources.allowWithoutAdminAuth).toBe('default');
  });
});

describe('SettingsStore', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-settings-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('persists patch to settings.json and hot-reloads effective values', () => {
    const paths = resolveAiAccessPaths(userDir);
    ensureAiAccessDirs(paths);
    const store = new SettingsStore(paths, {
      defaultLinkTtlSeconds: 7200,
      defaultDeploymentType: 'nodes',
    });

    expect(store.getEffective().defaultLinkTtlSeconds).toBe(7200);
    expect(store.getEffective().sources.defaultLinkTtlSeconds).toBe('settings.js');

    const updated = store.patch({
      defaultDeploymentType: 'full',
      defaultLinkTtlSeconds: 1800,
      enabled: false,
    });
    expect(updated.defaultDeploymentType).toBe('full');
    expect(updated.defaultLinkTtlSeconds).toBe(1800);
    expect(updated.enabled).toBe(false);
    expect(updated.sources.defaultDeploymentType).toBe('disk');

    const onDisk = JSON.parse(readFileSync(paths.settings, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toMatchObject({
      defaultDeploymentType: 'full',
      defaultLinkTtlSeconds: 1800,
      enabled: false,
    });

    const reloaded = new SettingsStore(paths, {
      defaultLinkTtlSeconds: 7200,
      defaultDeploymentType: 'nodes',
    });
    expect(reloaded.getEffective().defaultDeploymentType).toBe('full');
    expect(reloaded.getEffective().defaultLinkTtlSeconds).toBe(1800);
    expect(reloaded.getEffective().enabled).toBe(false);
  });
});
