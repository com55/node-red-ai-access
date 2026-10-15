/**
 * Resolve AI Access settings from Node-RED settings.js.
 */

import type { AiAccessSettings, NodeRedPluginSettings } from './types.js';

const DEFAULTS: Required<
  Pick<
    AiAccessSettings,
    'allowWithoutAdminAuth' | 'defaultLinkTtlSeconds' | 'maxActiveLinks' | 'defaultDeploymentType'
  >
> = {
  allowWithoutAdminAuth: false,
  defaultLinkTtlSeconds: 86_400,
  maxActiveLinks: 10,
  defaultDeploymentType: 'nodes',
};

export function isAdminAuthEnabled(settings: NodeRedPluginSettings): boolean {
  return settings.adminAuth != null && settings.adminAuth !== false;
}

export function resolveAiAccessSettings(
  settings: NodeRedPluginSettings
): Required<
  Pick<
    AiAccessSettings,
    'allowWithoutAdminAuth' | 'defaultLinkTtlSeconds' | 'maxActiveLinks' | 'defaultDeploymentType'
  >
> {
  const raw = settings.aiAccess ?? {};
  return {
    allowWithoutAdminAuth: raw.allowWithoutAdminAuth === true,
    defaultLinkTtlSeconds:
      typeof raw.defaultLinkTtlSeconds === 'number' && raw.defaultLinkTtlSeconds > 0
        ? raw.defaultLinkTtlSeconds
        : DEFAULTS.defaultLinkTtlSeconds,
    maxActiveLinks:
      typeof raw.maxActiveLinks === 'number' && raw.maxActiveLinks > 0
        ? raw.maxActiveLinks
        : DEFAULTS.maxActiveLinks,
    defaultDeploymentType:
      raw.defaultDeploymentType === 'flows' || raw.defaultDeploymentType === 'full'
        ? raw.defaultDeploymentType
        : DEFAULTS.defaultDeploymentType,
  };
}

/**
 * AI features require adminAuth, or an explicit local-only opt-in.
 */
export function areAiFeaturesEnabled(settings: NodeRedPluginSettings): boolean {
  if (isAdminAuthEnabled(settings)) {
    return true;
  }
  return resolveAiAccessSettings(settings).allowWithoutAdminAuth;
}
