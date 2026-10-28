/**
 * SettingsStore merge + disk persistence.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureAiAccessDirs, resolveAiAccessPaths } from '../../src/storage/paths.js';
import {
  mergeAiAccessSettings,
  settingsJsPartial,
  SettingsStore,
} from '../../src/storage/settings-store.js';

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

  it('drops invalid disk URLs and CORS entries and warns', () => {
    const paths = resolveAiAccessPaths(userDir);
    ensureAiAccessDirs(paths);
    writeFileSync(
      paths.settings,
      JSON.stringify({
        publicBaseUrl: 'http://public.example/path',
        corsAllowedOrigins: ['https://good.example/path', 'https://Good.Example'],
      })
    );
    const warn = vi.fn();
    const store = new SettingsStore(paths, undefined, warn);

    expect(store.getEffective().publicBaseUrl).toBe('');
    expect(store.getEffective().corsAllowedOrigins).toEqual(['https://good.example']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('publicBaseUrl'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid CORS origin'));
  });

  it('warns and falls back to defaults for corrupt config.json', () => {
    const paths = resolveAiAccessPaths(userDir);
    ensureAiAccessDirs(paths);
    writeFileSync(paths.settings, '{ invalid json');
    const warn = vi.fn();

    const store = new SettingsStore(paths, undefined, warn);

    expect(store.getEffective().enabled).toBe(true);
    expect(store.getEffective().sources.enabled).toBe('default');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt or unreadable'));
  });

  it('drops non-integer and out-of-range rate limits from disk', () => {
    const paths = resolveAiAccessPaths(userDir);
    ensureAiAccessDirs(paths);
    writeFileSync(
      paths.settings,
      JSON.stringify({
        rateLimitWindowMs: 1.5,
        rateLimitMaxPerIp: 1_000_001,
        rateLimitMaxPerToken: 1,
      })
    );

    const store = new SettingsStore(paths);

    expect(store.getEffective().rateLimitWindowMs).toBe(60_000);
    expect(store.getEffective().rateLimitMaxPerIp).toBe(600);
    expect(store.getEffective().rateLimitMaxPerToken).toBe(1);
  });
  it('defaults the OAuth refresh max lifetime to 90 days and accepts 0 as unlimited', () => {
    expect(mergeAiAccessSettings({}, {}).oauth.refreshMaxLifetimeSec).toBe(7_776_000);
    expect(
      mergeAiAccessSettings({}, { oauth: { refreshMaxLifetimeSec: 0 } }).oauth.refreshMaxLifetimeSec
    ).toBe(0);
  });
  it('locks settings.js OAuth fields against disk values and warns on invalid ones', () => {
    const warn = vi.fn();
    const sjs = settingsJsPartial(
      { oauth: { accessTokenTtlSec: -5, refreshIdleTtlSec: 7200 } },
      warn
    );
    const merged = mergeAiAccessSettings(sjs, {
      oauth: { accessTokenTtlSec: 600, refreshIdleTtlSec: 60, dcrMaxClients: 5 },
    });
    expect(merged.oauth.accessTokenTtlSec).toBe(3600);
    expect(merged.oauth.refreshIdleTtlSec).toBe(7200);
    expect(merged.oauth.dcrMaxClients).toBe(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('oauth.accessTokenTtlSec'));
  });
});
