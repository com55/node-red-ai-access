/**
 * Persisted AI Access settings under `<userDir>/.ai-access/config.json`.
 *
 * Precedence for effective values (highest wins):
 * 1. `settings.js` `aiAccess` block (locked keys)
 * 2. Disk file keys present in `.ai-access/config.json` (sidebar AI Access UI)
 * 3. Built-in defaults
 *
 * Changes via PUT /mcp/api/v1/settings update memory + disk immediately
 * (no Node-RED restart).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeCorsOrigins } from '../plugin/cors.js';
import type { DeploymentType } from '../runtime/types.js';

import type { AiAccessPaths } from './paths.js';
import {
  encodeTrustedJson,
  type TrustedStoragePayload,
  writeTrustedAtomic,
} from './trusted-write.js';

/** Max size for config.json (pretty-printed). */
export const MAX_SETTINGS_JSON_BYTES = 16_384;

export interface PersistedAiAccessSettings {
  /** When false, AI features are off even if adminAuth is enabled. Default true. */
  enabled?: boolean;
  allowWithoutAdminAuth?: boolean;
  defaultLinkTtlSeconds?: number;
  defaultDeploymentType?: DeploymentType;
  maxActiveLinks?: number;
  publicBaseUrl?: string;
  corsAllowedOrigins?: string[];
  rateLimitWindowMs?: number;
  rateLimitMaxPerIp?: number;
  rateLimitMaxPerToken?: number;
}

export interface EffectiveAiAccessSettings {
  enabled: boolean;
  allowWithoutAdminAuth: boolean;
  defaultLinkTtlSeconds: number;
  defaultDeploymentType: DeploymentType;
  maxActiveLinks: number;
  publicBaseUrl: string;
  corsAllowedOrigins: string[];
  rateLimitWindowMs: number;
  rateLimitMaxPerIp: number;
  rateLimitMaxPerToken: number;
}

export type SettingsSource = 'default' | 'settings.js' | 'disk';

export interface EffectiveAiAccessSettingsWithMeta extends EffectiveAiAccessSettings {
  sources: Record<keyof EffectiveAiAccessSettings, SettingsSource>;
}

const BUILTIN: EffectiveAiAccessSettings = {
  enabled: true,
  allowWithoutAdminAuth: false,
  defaultLinkTtlSeconds: 14_400,
  maxActiveLinks: 10,
  defaultDeploymentType: 'nodes',
  publicBaseUrl: '',
  corsAllowedOrigins: [],
  rateLimitWindowMs: 60_000,
  rateLimitMaxPerIp: 600,
  rateLimitMaxPerToken: 300,
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
  if (typeof data.publicBaseUrl === 'string') out.publicBaseUrl = data.publicBaseUrl;
  if (Array.isArray(data.corsAllowedOrigins))
    out.corsAllowedOrigins = normalizeCorsOrigins(data.corsAllowedOrigins);
  for (const key of ['rateLimitWindowMs', 'rateLimitMaxPerIp', 'rateLimitMaxPerToken'] as const) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value;
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
 * Merge defaults ← disk ← settings.js (settings.js keys are locked).
 */
export function mergeAiAccessSettings(
  fromSettingsJs: PersistedAiAccessSettings,
  fromDisk: PersistedAiAccessSettings
): EffectiveAiAccessSettingsWithMeta {
  const sources = {} as EffectiveAiAccessSettingsWithMeta['sources'];
  const effective = { ...BUILTIN };
  for (const key of Object.keys(BUILTIN) as (keyof EffectiveAiAccessSettings)[]) {
    sources[key] =
      fromSettingsJs[key] !== undefined
        ? 'settings.js'
        : fromDisk[key] !== undefined
          ? 'disk'
          : 'default';
    Object.assign(effective, { [key]: fromSettingsJs[key] ?? fromDisk[key] ?? BUILTIN[key] });
  }
  return { ...effective, sources };
}

export function settingsJsPartial(
  aiAccess: PersistedAiAccessSettings | undefined
): PersistedAiAccessSettings {
  const sanitized = sanitizePartial(aiAccess ?? {});
  // A present settings.js key is always locked, even if its invalid value needs a default.
  for (const key of Object.keys(BUILTIN) as (keyof EffectiveAiAccessSettings)[]) {
    if (aiAccess && Object.hasOwn(aiAccess, key) && sanitized[key] === undefined) {
      Object.assign(sanitized, { [key]: BUILTIN[key] });
    }
  }
  return sanitized;
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
    this.filePath = join(paths.root, 'config.json');
    this.settingsJs = settingsJsPartial(settingsJsAiAccess);
    this.disk = readDiskFile(
      existsSync(this.filePath) ? this.filePath : join(paths.root, 'settings.json')
    );
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
    for (const key of Object.keys(this.settingsJs) as (keyof PersistedAiAccessSettings)[]) {
      delete next[key];
    }
    this.persist(next);
    this.disk = next;
    this.cached = mergeAiAccessSettings(this.settingsJs, this.disk);
    return this.cached;
  }

  /** Merge into existing disk overrides (only provided keys change). */
  patch(partial: PersistedAiAccessSettings): EffectiveAiAccessSettingsWithMeta {
    return this.update({ ...this.disk, ...sanitizePartial(partial) });
  }

  private persist(next: PersistedAiAccessSettings): void {
    const payload: TrustedStoragePayload = encodeTrustedJson(next, MAX_SETTINGS_JSON_BYTES, {
      kind: 'settings',
      pretty: true,
    });
    writeTrustedAtomic(this.paths.root, this.filePath, payload);
  }
}
