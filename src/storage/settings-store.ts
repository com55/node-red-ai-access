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

import { validateSettingsPublicBaseUrl } from '../plugin/access-path.js';
import { canonicalOrigin } from '../plugin/cors.js';
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
  oauth?: {
    enabled?: boolean;
    accessTokenTtlSec?: number;
    refreshIdleTtlSec?: number;
    refreshMaxLifetimeSec?: number;
    dcrMaxClients?: number;
  };
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
  oauth: {
    enabled: boolean;
    accessTokenTtlSec: number;
    refreshIdleTtlSec: number;
    refreshMaxLifetimeSec: number;
    dcrMaxClients: number;
  };
}

export type SettingsSource = 'default' | 'settings.js' | 'disk';

export interface EffectiveAiAccessSettingsWithMeta extends EffectiveAiAccessSettings {
  sources: Record<keyof EffectiveAiAccessSettings, SettingsSource>;
}

const DEFAULT_OAUTH = {
  enabled: false,
  accessTokenTtlSec: 3600,
  refreshIdleTtlSec: 2_592_000,
  refreshMaxLifetimeSec: 7_776_000,
  dcrMaxClients: 5,
};

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
  oauth: { ...DEFAULT_OAUTH },
};

function isDeploymentType(value: unknown): value is DeploymentType {
  return value === 'nodes' || value === 'flows' || value === 'full';
}

type Warn = (message: string) => void;

function sanitizePartial(raw: unknown, warn?: Warn): PersistedAiAccessSettings {
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
  if (typeof data.publicBaseUrl === 'string') {
    try {
      out.publicBaseUrl = validateSettingsPublicBaseUrl(data.publicBaseUrl);
    } catch {
      warn?.(
        `AI Access: invalid publicBaseUrl value ${JSON.stringify(data.publicBaseUrl)} was dropped`
      );
    }
  }
  if (Array.isArray(data.corsAllowedOrigins)) {
    const origins = new Set<string>();
    for (const value of data.corsAllowedOrigins) {
      const canonical = canonicalOrigin(value);
      if (canonical) origins.add(canonical);
      else warn?.(`AI Access: invalid CORS origin value ${JSON.stringify(value)} was dropped`);
    }
    out.corsAllowedOrigins = [...origins];
  }
  for (const key of ['rateLimitWindowMs', 'rateLimitMaxPerIp', 'rateLimitMaxPerToken'] as const) {
    const value = data[key];
    const min = key === 'rateLimitWindowMs' ? 100 : 1;
    const max = key === 'rateLimitWindowMs' ? 3_600_000 : 1_000_000;
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
      out[key] = value;
    }
  }
  if (data.oauth && typeof data.oauth === 'object' && !Array.isArray(data.oauth)) {
    const oauth = data.oauth as Record<string, unknown>;
    out.oauth = {};
    if (typeof oauth.enabled === 'boolean') out.oauth.enabled = oauth.enabled;
    for (const key of ['accessTokenTtlSec', 'refreshIdleTtlSec', 'dcrMaxClients'] as const) {
      const value = oauth[key];
      if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 31_536_000)
        out.oauth[key] = value;
    }
    const max = oauth.refreshMaxLifetimeSec;
    if (typeof max === 'number' && Number.isInteger(max) && max >= 0 && max <= 315_360_000)
      out.oauth.refreshMaxLifetimeSec = max;
  }
  return out;
}

function readDiskFile(filePath: string, warn?: Warn): PersistedAiAccessSettings {
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const text = readFileSync(filePath, 'utf8');
    return sanitizePartial(JSON.parse(text) as unknown, warn);
  } catch (error) {
    warn?.(`AI Access: config.json is corrupt or unreadable; defaults are used (${String(error)})`);
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
  for (const key of Object.keys(BUILTIN).filter(
    key => key !== 'oauth'
  ) as (keyof EffectiveAiAccessSettings)[]) {
    sources[key] =
      fromSettingsJs[key] !== undefined
        ? 'settings.js'
        : fromDisk[key] !== undefined
          ? 'disk'
          : 'default';
    Object.assign(effective, { [key]: fromSettingsJs[key] ?? fromDisk[key] ?? BUILTIN[key] });
  }
  const merged = { ...effective, sources };
  if (fromSettingsJs.oauth !== undefined || fromDisk.oauth !== undefined) {
    merged.oauth = { ...DEFAULT_OAUTH, ...(fromDisk.oauth ?? {}), ...(fromSettingsJs.oauth ?? {}) };
    sources.oauth = fromSettingsJs.oauth !== undefined ? 'settings.js' : 'disk';
  } else {
    merged.oauth = { ...DEFAULT_OAUTH };
    sources.oauth = 'default';
  }
  return merged;
}

export function settingsJsPartial(
  aiAccess: PersistedAiAccessSettings | undefined,
  warn?: Warn
): PersistedAiAccessSettings {
  const sanitized = sanitizePartial(aiAccess ?? {}, warn);
  // A present settings.js key is always locked, even if its invalid value needs a default.
  for (const key of Object.keys(BUILTIN).filter(
    key => key !== 'oauth'
  ) as (keyof EffectiveAiAccessSettings)[]) {
    if (aiAccess && Object.hasOwn(aiAccess, key) && sanitized[key] === undefined) {
      Object.assign(sanitized, { [key]: BUILTIN[key] });
    }
  }
  // Same for oauth fields: an invalid settings.js value falls back to the default
  // (never to a disk value) and is reported.
  const rawOauth = (aiAccess as { oauth?: unknown } | undefined)?.oauth;
  if (rawOauth && typeof rawOauth === 'object' && !Array.isArray(rawOauth)) {
    const oauth = (sanitized.oauth ??= {});
    for (const key of Object.keys(DEFAULT_OAUTH) as (keyof typeof DEFAULT_OAUTH)[]) {
      if (Object.hasOwn(rawOauth, key) && oauth[key] === undefined) {
        warn?.(
          `AI Access: settings.js aiAccess.oauth.${key} is invalid; using the default (${String(DEFAULT_OAUTH[key])})`
        );
        Object.assign(oauth, { [key]: DEFAULT_OAUTH[key] });
      }
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
    settingsJsAiAccess?: PersistedAiAccessSettings,
    warn?: Warn
  ) {
    this.filePath = join(paths.root, 'config.json');
    this.settingsJs = settingsJsPartial(settingsJsAiAccess, warn);
    this.disk = readDiskFile(
      existsSync(this.filePath) ? this.filePath : join(paths.root, 'settings.json'),
      warn
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
    const sanitized = sanitizePartial(partial);
    return this.update({
      ...this.disk,
      ...sanitized,
      ...(sanitized.oauth ? { oauth: { ...this.disk.oauth, ...sanitized.oauth } } : {}),
    });
  }

  private persist(next: PersistedAiAccessSettings): void {
    const payload: TrustedStoragePayload = encodeTrustedJson(next, MAX_SETTINGS_JSON_BYTES, {
      kind: 'settings',
      pretty: true,
    });
    writeTrustedAtomic(this.paths.root, this.filePath, payload);
  }
}
