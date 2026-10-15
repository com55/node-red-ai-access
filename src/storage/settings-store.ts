/**
 * Persisted AI Access settings under `<userDir>/.ai-access/settings.json`.
 *
 * Precedence for effective values (highest wins):
 * 1. Disk file keys present in `.ai-access/settings.json` (User Settings UI)
 * 2. `settings.js` `aiAccess` block
 * 3. Built-in defaults
 *
 * Changes via PUT /mcp/api/v1/settings update memory + disk immediately
 * (no Node-RED restart).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DeploymentType } from '../runtime/types.js';

import type { AiAccessPaths } from './paths.js';
import {
  encodeTrustedJson,
  type TrustedStoragePayload,
  writeTrustedAtomic,
} from './trusted-write.js';

/** Max size for settings.json (pretty-printed). */
export const MAX_SETTINGS_JSON_BYTES = 16_384;

export interface PersistedAiAccessSettings {
  /** When false, AI features are off even if adminAuth is enabled. Default true. */
  enabled?: boolean;
  allowWithoutAdminAuth?: boolean;
  defaultLinkTtlSeconds?: number;
  defaultDeploymentType?: DeploymentType;
  maxActiveLinks?: number;
}

export interface EffectiveAiAccessSettings {
  enabled: boolean;
  allowWithoutAdminAuth: boolean;
  defaultLinkTtlSeconds: number;
  defaultDeploymentType: DeploymentType;
  maxActiveLinks: number;
}

export type SettingsSource = 'default' | 'settings.js' | 'disk';

export interface EffectiveAiAccessSettingsWithMeta extends EffectiveAiAccessSettings {
  sources: Record<keyof EffectiveAiAccessSettings, SettingsSource>;
}

const BUILTIN: EffectiveAiAccessSettings = {
  enabled: true,
  allowWithoutAdminAuth: false,
  defaultLinkTtlSeconds: 86_400,
  maxActiveLinks: 10,
  defaultDeploymentType: 'nodes',
};

function isDeploymentType(value: unknown): value is DeploymentType {
  return value === 'nodes' || value === 'flows' || value === 'full';
}

function sanitizePartial(raw: unknown): PersistedAiAccessSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const data = raw as Record<string, unknown>;
  const out: PersistedAiAccessSettings = {};
  if (typeof data.enabled === 'boolean') {
    out.enabled = data.enabled;
  }
  if (typeof data.allowWithoutAdminAuth === 'boolean') {
    out.allowWithoutAdminAuth = data.allowWithoutAdminAuth;
  }
  if (
    typeof data.defaultLinkTtlSeconds === 'number' &&
    Number.isFinite(data.defaultLinkTtlSeconds) &&
    data.defaultLinkTtlSeconds > 0
  ) {
    out.defaultLinkTtlSeconds = Math.floor(data.defaultLinkTtlSeconds);
  }
  if (isDeploymentType(data.defaultDeploymentType)) {
    out.defaultDeploymentType = data.defaultDeploymentType;
  }
  if (
    typeof data.maxActiveLinks === 'number' &&
    Number.isFinite(data.maxActiveLinks) &&
    data.maxActiveLinks > 0
  ) {
    out.maxActiveLinks = Math.floor(data.maxActiveLinks);
  }
  return out;
}

function readDiskFile(filePath: string): PersistedAiAccessSettings {
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const text = readFileSync(filePath, 'utf8');
    return sanitizePartial(JSON.parse(text) as unknown);
  } catch {
    return {};
  }
}

/**
 * Merge defaults ← settings.js ← disk (disk wins for keys it defines).
 */
export function mergeAiAccessSettings(
  fromSettingsJs: PersistedAiAccessSettings,
  fromDisk: PersistedAiAccessSettings
): EffectiveAiAccessSettingsWithMeta {
  const sources: EffectiveAiAccessSettingsWithMeta['sources'] = {
    enabled: 'default',
    allowWithoutAdminAuth: 'default',
    defaultLinkTtlSeconds: 'default',
    defaultDeploymentType: 'default',
    maxActiveLinks: 'default',
  };

  const pick = <K extends keyof EffectiveAiAccessSettings>(
    key: K,
    fallback: EffectiveAiAccessSettings[K]
  ): EffectiveAiAccessSettings[K] => {
    if (fromDisk[key] !== undefined) {
      sources[key] = 'disk';
      return fromDisk[key] as EffectiveAiAccessSettings[K];
    }
    if (fromSettingsJs[key] !== undefined) {
      sources[key] = 'settings.js';
      return fromSettingsJs[key] as EffectiveAiAccessSettings[K];
    }
    sources[key] = 'default';
    return fallback;
  };

  return {
    enabled: pick('enabled', BUILTIN.enabled),
    allowWithoutAdminAuth: pick('allowWithoutAdminAuth', BUILTIN.allowWithoutAdminAuth),
    defaultLinkTtlSeconds: pick('defaultLinkTtlSeconds', BUILTIN.defaultLinkTtlSeconds),
    defaultDeploymentType: pick('defaultDeploymentType', BUILTIN.defaultDeploymentType),
    maxActiveLinks: pick('maxActiveLinks', BUILTIN.maxActiveLinks),
    sources,
  };
}

export function settingsJsPartial(
  aiAccess: PersistedAiAccessSettings | undefined
): PersistedAiAccessSettings {
  return sanitizePartial(aiAccess ?? {});
}

export class SettingsStore {
  private readonly filePath: string;
  private disk: PersistedAiAccessSettings;
  private settingsJs: PersistedAiAccessSettings;
  private cached: EffectiveAiAccessSettingsWithMeta;

  constructor(
    private readonly paths: AiAccessPaths,
    settingsJsAiAccess?: PersistedAiAccessSettings
  ) {
    this.filePath = join(paths.root, 'settings.json');
    this.settingsJs = settingsJsPartial(settingsJsAiAccess);
    this.disk = readDiskFile(this.filePath);
    this.cached = mergeAiAccessSettings(this.settingsJs, this.disk);
  }

  getEffective(): EffectiveAiAccessSettingsWithMeta {
    return this.cached;
  }

  getDisk(): PersistedAiAccessSettings {
    return { ...this.disk };
  }

  /**
   * Replace disk overrides with the given partial (omit a key to clear that
   * disk override and fall back to settings.js / default).
   */
  update(partial: PersistedAiAccessSettings): EffectiveAiAccessSettingsWithMeta {
    const next = sanitizePartial(partial);
    this.disk = next;
    this.persist();
    this.cached = mergeAiAccessSettings(this.settingsJs, this.disk);
    return this.cached;
  }

  /** Merge into existing disk overrides (only provided keys change). */
  patch(partial: PersistedAiAccessSettings): EffectiveAiAccessSettingsWithMeta {
    return this.update({ ...this.disk, ...sanitizePartial(partial) });
  }

  private persist(): void {
    const payload: TrustedStoragePayload = encodeTrustedJson(this.disk, MAX_SETTINGS_JSON_BYTES, {
      kind: 'settings',
      pretty: true,
    });
    writeTrustedAtomic(this.paths.root, this.filePath, payload);
  }
}
