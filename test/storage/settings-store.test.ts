/**
 * SettingsStore merge + disk persistence.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureAiAccessDirs, resolveAiAccessPaths } from '../../src/storage/paths.js';
import { mergeAiAccessSettings, SettingsStore } from '../../src/storage/settings-store.js';

describe('mergeAiAccessSettings', () => {
  it('applies settings.js over disk over defaults', () => {
    const merged = mergeAiAccessSettings(
      { defaultLinkTtlSeconds: 3600, defaultDeploymentType: 'flows' },
      { defaultDeploymentType: 'full', enabled: false }
    );
    expect(merged.enabled).toBe(false);
    expect(merged.sources.enabled).toBe('disk');
    expect(merged.defaultLinkTtlSeconds).toBe(3600);
    expect(merged.sources.defaultLinkTtlSeconds).toBe('settings.js');
    expect(merged.defaultDeploymentType).toBe('flows');
    expect(merged.sources.defaultDeploymentType).toBe('settings.js');
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

  it('persists unlocked patch to config.json and hot-reloads effective values', () => {
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
    expect(updated.defaultDeploymentType).toBe('nodes');
    expect(updated.defaultLinkTtlSeconds).toBe(7200);
    expect(updated.enabled).toBe(false);
    expect(updated.sources.defaultDeploymentType).toBe('settings.js');

    const onDisk = JSON.parse(readFileSync(paths.settings, 'utf8')) as Record<string, unknown>;
    expect(paths.settings).toBe(join(paths.root, 'config.json'));
    expect(onDisk).toEqual({ enabled: false });

    const reloaded = new SettingsStore(paths, {
      defaultLinkTtlSeconds: 7200,
      defaultDeploymentType: 'nodes',
    });
    expect(reloaded.getEffective().defaultDeploymentType).toBe('nodes');
    expect(reloaded.getEffective().defaultLinkTtlSeconds).toBe(7200);
    expect(reloaded.getEffective().enabled).toBe(false);
  });
  it('loads legacy settings.json and writes config.json on next save', () => {
    const paths = resolveAiAccessPaths(userDir);
    ensureAiAccessDirs(paths);
    writeFileSync(
      join(paths.root, 'settings.json'),
      JSON.stringify({ enabled: false, defaultLinkTtlSeconds: 7200 })
    );
    const store = new SettingsStore(paths);
    expect(store.getEffective()).toMatchObject({ enabled: false, defaultLinkTtlSeconds: 7200 });
    store.patch({
      publicBaseUrl: 'https://public.example',
      corsAllowedOrigins: ['https://browser.example'],
      rateLimitMaxPerIp: 123,
    });
    const reloaded = new SettingsStore(paths);
    expect(reloaded.getEffective()).toMatchObject({
      enabled: false,
      defaultLinkTtlSeconds: 7200,
      publicBaseUrl: 'https://public.example',
      corsAllowedOrigins: ['https://browser.example'],
      rateLimitMaxPerIp: 123,
    });
    // The new file takes precedence over the legacy file, even if the latter changes.
    writeFileSync(join(paths.root, 'settings.json'), JSON.stringify({ enabled: true }));
    expect(new SettingsStore(paths).getEffective().enabled).toBe(false);
    expect(new SettingsStore(paths, { enabled: true }).getEffective().enabled).toBe(true);
  });
});
