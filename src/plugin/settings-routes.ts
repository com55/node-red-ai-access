/**
 * Admin GET/PUT /mcp/api/v1/settings — editable AI Access configuration.
 */

import type { Response } from 'express';

import type { AccessLinkStore } from '../access/link-store.js';
import type { PersistedAiAccessSettings, SettingsStore } from '../storage/settings-store.js';
import { StoragePayloadTooLargeError } from '../storage/trusted-write.js';

import { bindPublicBaseUrl, validateSettingsPublicBaseUrl } from './access-path.js';
import { mcpApiBase, normalizeHttpAdminRoot, resolvePermission } from './auth.js';
import { canonicalOrigin } from './cors.js';
import { sendCaughtRouteError } from './route-errors.js';
import { isAdminAuthEnabled } from './settings.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

function mcpPageUrl(RED: NodeRedPluginAPI): string {
  const root = normalizeHttpAdminRoot(RED.settings.httpAdminRoot);
  return root === '/' ? '/mcp' : `${root}/mcp`;
}

function normalizeTrustProxy(value: unknown): boolean | number | string {
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
    return value;
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'function' ? 'custom function' : false;
}

function settingsResponse(RED: NodeRedPluginAPI, store: SettingsStore, req: AuthenticatedRequest) {
  const { sources, ...settings } = store.getEffective();
  const permission = resolvePermission(req);
  const adminAuthEnabled = isAdminAuthEnabled(RED.settings);
  return {
    ok: true,
    adminAuthEnabled,
    canEdit: permission === '*',
    permission,
    mcpPageUrl: mcpPageUrl(RED),
    apiBase: mcpApiBase(RED.settings.httpAdminRoot),
    // Add future settings to the shared effective type; sources also drives locks.
    settings,
    sources,
    disk: store.getDisk(),
    trustProxy: normalizeTrustProxy(req.app.get('trust proxy')),
    precedence: ['settings.js', 'disk', 'default'] as const,
  };
}

/** Shared sidebar settings surface; extend the effective settings and sources together. */
export type SettingsApiResponse = ReturnType<typeof settingsResponse>;

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
    const body = { ...(raw as Record<string, unknown>) };
    for (const [key, source] of Object.entries(store.getEffective().sources)) {
      if (source === 'settings.js') delete body[key];
    }

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
      if (body.publicBaseUrl !== undefined)
        patch.publicBaseUrl = validateSettingsPublicBaseUrl(body.publicBaseUrl);
      if (body.corsAllowedOrigins !== undefined) {
        if (!Array.isArray(body.corsAllowedOrigins))
          throw new Error('corsAllowedOrigins must be a list of HTTP(S) origins');
        const origins = body.corsAllowedOrigins.map(entry => canonicalOrigin(entry));
        if (origins.some(origin => origin === undefined))
          throw new Error(
            'corsAllowedOrigins must contain only HTTP(S) origins without paths, credentials, queries, or fragments'
          );
        patch.corsAllowedOrigins = [...new Set(origins as string[])];
      }
      for (const key of [
        'rateLimitWindowMs',
        'rateLimitMaxPerIp',
        'rateLimitMaxPerToken',
      ] as const) {
        const value = body[key];
        if (value !== undefined) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
            throw new Error(`${key} must be a positive finite number`);
          patch[key] = value;
        }
      }
    } catch (error) {
      res.status(400).json({ error: (error as Error).message, code: 'invalid_body' });
      return;
    }

    try {
      const effective = store.patch(patch);
      bindPublicBaseUrl(effective.publicBaseUrl);
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
      sendCaughtRouteError(res, error);
      return;
    }
  };
}

/** Star-only outbound probe; never follow redirects or fetch a caller-supplied path. */
export function checkPublicUrlHandler(RED: NodeRedPluginAPI) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    let origin: string;
    try {
      origin = validateSettingsPublicBaseUrl(
        (req.body as { publicBaseUrl?: unknown } | undefined)?.publicBaseUrl
      );
      if (!origin) throw new Error('publicBaseUrl is required for Check');
    } catch (error) {
      res.status(400).json({ error: (error as Error).message, code: 'invalid_body' });
      return;
    }
    const url = origin + mcpApiBase(RED.settings.httpAdminRoot);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const result = await fetch(url, { redirect: 'manual', signal: controller.signal });
      // Only headers/status are needed; release the response without downloading its body.
      await result.body?.cancel();
      res.json({
        ok: result.ok,
        status: result.status,
        url,
        message: result.ok
          ? 'Discovery endpoint is reachable'
          : `Discovery endpoint returned HTTP ${result.status}`,
      });
    } catch {
      res.json({
        ok: false,
        status: null,
        url,
        error: controller.signal.aborted
          ? 'Public URL check timed out after 5 seconds'
          : 'Could not reach the discovery endpoint',
      });
    } finally {
      clearTimeout(timer);
    }
  };
}
