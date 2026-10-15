/**
 * Admin GET/PUT /mcp/api/v1/settings — editable AI Access configuration.
 */

import type { Response } from 'express';

import type { AccessLinkStore } from '../access/link-store.js';
import type { PersistedAiAccessSettings, SettingsStore } from '../storage/settings-store.js';
import { StoragePayloadTooLargeError } from '../storage/trusted-write.js';

import { mcpApiBase, normalizeHttpAdminRoot, resolvePermission } from './auth.js';
import { isAdminAuthEnabled } from './settings.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

function mcpPageUrl(RED: NodeRedPluginAPI): string {
  const root = normalizeHttpAdminRoot(RED.settings.httpAdminRoot);
  return root === '/' ? '/mcp' : `${root}/mcp`;
}

function settingsResponse(RED: NodeRedPluginAPI, store: SettingsStore, req: AuthenticatedRequest) {
  const effective = store.getEffective();
  const permission = resolvePermission(req);
  const adminAuthEnabled = isAdminAuthEnabled(RED.settings);
  return {
    ok: true,
    adminAuthEnabled,
    canEdit: permission === '*',
    permission,
    mcpPageUrl: mcpPageUrl(RED),
    apiBase: mcpApiBase(RED.settings.httpAdminRoot),
    settings: {
      enabled: effective.enabled,
      allowWithoutAdminAuth: effective.allowWithoutAdminAuth,
      defaultLinkTtlSeconds: effective.defaultLinkTtlSeconds,
      defaultDeploymentType: effective.defaultDeploymentType,
      maxActiveLinks: effective.maxActiveLinks,
    },
    sources: effective.sources,
    disk: store.getDisk(),
    /**
     * Precedence (highest wins): disk `.ai-access/settings.json` →
     * `settings.js` `aiAccess` → built-in defaults.
     */
    precedence: ['disk', 'settings.js', 'default'] as const,
  };
}

export function getSettingsHandler(RED: NodeRedPluginAPI, store: SettingsStore) {
  return (req: AuthenticatedRequest, res: Response): void => {
    res.json(settingsResponse(RED, store, req));
  };
}

export function putSettingsHandler(
  RED: NodeRedPluginAPI,
  store: SettingsStore,
  linkStore: AccessLinkStore
) {
  return (req: AuthenticatedRequest, res: Response): void => {
    const raw: unknown = req.body;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      res
        .status(400)
        .json({ error: 'Request body must be a settings object', code: 'invalid_body' });
      return;
    }
    const body = raw as Record<string, unknown>;

    const patch: PersistedAiAccessSettings = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean', code: 'invalid_body' });
        return;
      }
      patch.enabled = body.enabled;
    }
    if (body.allowWithoutAdminAuth !== undefined) {
      if (typeof body.allowWithoutAdminAuth !== 'boolean') {
        res
          .status(400)
          .json({ error: 'allowWithoutAdminAuth must be a boolean', code: 'invalid_body' });
        return;
      }
      patch.allowWithoutAdminAuth = body.allowWithoutAdminAuth;
    }
    if (body.defaultLinkTtlSeconds !== undefined) {
      if (
        typeof body.defaultLinkTtlSeconds !== 'number' ||
        !Number.isFinite(body.defaultLinkTtlSeconds) ||
        body.defaultLinkTtlSeconds <= 0
      ) {
        res
          .status(400)
          .json({ error: 'defaultLinkTtlSeconds must be a positive number', code: 'invalid_body' });
        return;
      }
      patch.defaultLinkTtlSeconds = Math.floor(body.defaultLinkTtlSeconds);
    }
    if (body.defaultDeploymentType !== undefined) {
      const deploy = body.defaultDeploymentType;
      if (deploy !== 'nodes' && deploy !== 'flows' && deploy !== 'full') {
        res.status(400).json({
          error: "defaultDeploymentType must be 'nodes', 'flows', or 'full'",
          code: 'invalid_body',
        });
        return;
      }
      patch.defaultDeploymentType = deploy;
    }
    if (body.maxActiveLinks !== undefined) {
      if (
        typeof body.maxActiveLinks !== 'number' ||
        !Number.isFinite(body.maxActiveLinks) ||
        body.maxActiveLinks <= 0
      ) {
        res
          .status(400)
          .json({ error: 'maxActiveLinks must be a positive number', code: 'invalid_body' });
        return;
      }
      patch.maxActiveLinks = Math.floor(body.maxActiveLinks);
    }

    try {
      const effective = store.patch(patch);
      linkStore.configureDefaults({
        defaultTtlSeconds: effective.defaultLinkTtlSeconds,
        maxActiveLinks: effective.maxActiveLinks,
      });
      res.json(settingsResponse(RED, store, req));
    } catch (error) {
      if (error instanceof StoragePayloadTooLargeError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  };
}
