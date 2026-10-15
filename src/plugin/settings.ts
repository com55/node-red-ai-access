/**
 * Resolve AI Access settings from settings.js + optional disk store.
 */

import type {
  EffectiveAiAccessSettings,
  EffectiveAiAccessSettingsWithMeta,
  PersistedAiAccessSettings,
  SettingsStore,
} from '../storage/settings-store.js';
import { mergeAiAccessSettings, settingsJsPartial } from '../storage/settings-store.js';

import type { AiAccessSettings, NodeRedPluginSettings } from './types.js';

export type { EffectiveAiAccessSettings, PersistedAiAccessSettings };

/** Process-wide store set at plugin load (hot-reloaded via PUT /settings). */
let activeStore: SettingsStore | null = null;

export function bindSettingsStore(store: SettingsStore | null): void {
  activeStore = store;
}

export function getSettingsStore(): SettingsStore | null {
  return activeStore;
}

export function isAdminAuthEnabled(settings: NodeRedPluginSettings): boolean {
  return settings.adminAuth != null && settings.adminAuth !== false;
}

/**
 * Effective AI Access settings. When a {@link SettingsStore} is bound,
 * disk overrides apply without restart; otherwise falls back to settings.js.
 */
export function resolveAiAccessSettings(
  settings: NodeRedPluginSettings
): EffectiveAiAccessSettings {
  if (activeStore) {
    const effective = activeStore.getEffective();
    return {
      enabled: effective.enabled,
      allowWithoutAdminAuth: effective.allowWithoutAdminAuth,
      defaultLinkTtlSeconds: effective.defaultLinkTtlSeconds,
      defaultDeploymentType: effective.defaultDeploymentType,
      maxActiveLinks: effective.maxActiveLinks,
    };
  }
  const merged = mergeAiAccessSettings(settingsJsPartial(settings.aiAccess), {});
  return {
    enabled: merged.enabled,
    allowWithoutAdminAuth: merged.allowWithoutAdminAuth,
    defaultLinkTtlSeconds: merged.defaultLinkTtlSeconds,
    defaultDeploymentType: merged.defaultDeploymentType,
    maxActiveLinks: merged.maxActiveLinks,
  };
}

export function resolveAiAccessSettingsWithMeta(
  settings: NodeRedPluginSettings
): EffectiveAiAccessSettingsWithMeta {
  if (activeStore) {
    return activeStore.getEffective();
  }
  return mergeAiAccessSettings(settingsJsPartial(settings.aiAccess), {});
}

/**
 * AI features require `enabled` (default true) and either adminAuth or the
 * local-only `allowWithoutAdminAuth` opt-in.
 */
export function areAiFeaturesEnabled(settings: NodeRedPluginSettings): boolean {
  const ai = resolveAiAccessSettings(settings);
  if (!ai.enabled) {
    return false;
  }
  if (isAdminAuthEnabled(settings)) {
    return true;
  }
  return ai.allowWithoutAdminAuth;
}

/** @deprecated Prefer resolveAiAccessSettings; kept for typed AiAccessSettings reads. */
export function coerceAiAccessSettings(
  raw: AiAccessSettings | undefined
): PersistedAiAccessSettings {
  return settingsJsPartial(raw);
}
