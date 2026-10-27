/**
 * Admin GET/PUT /mcp/api/v1/settings — editable AI Access configuration.
 */

import type { Response } from 'express';

import type { AccessLinkStore } from '../access/link-store.js';
import type { PersistedAiAccessSettings, SettingsStore } from '../storage/settings-store.js';
import { StoragePayloadTooLargeError } from '../storage/trusted-write.js';

import { bindPublicBaseUrl, validateSettingsPublicBaseUrl } from './access-path.js';
import { describeAccess, mcpApiBase, normalizeHttpAdminRoot } from './auth.js';
import { canonicalOrigin } from './cors.js';
import { preparePublicUrlCheck, requestPublicUrlCheck } from './public-url-check.js';
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
  const { permission } = describeAccess(RED, req);
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

function parseBooleanField(
  body: Record<string, unknown>,
  key: 'enabled' | 'allowWithoutAdminAuth',
  patch: PersistedAiAccessSettings
): void {
  const value = body[key];
  if (value === undefined) return;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  patch[key] = value;
}

function parsePositiveIntField(
  body: Record<string, unknown>,
  key: 'defaultLinkTtlSeconds' | 'maxActiveLinks',
  patch: PersistedAiAccessSettings
): void {
  const value = body[key];
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error(`${key} must be a positive number`);
  patch[key] = Math.floor(value);
}

function parseRateLimitField(
  body: Record<string, unknown>,
  key: 'rateLimitWindowMs' | 'rateLimitMaxPerIp' | 'rateLimitMaxPerToken',
  patch: PersistedAiAccessSettings
): void {
  const value = body[key];
  if (value === undefined) return;
  const min = key === 'rateLimitWindowMs' ? 100 : 1;
  const max = key === 'rateLimitWindowMs' ? 3_600_000 : 1_000_000;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  patch[key] = value;
}

function parseCorsField(body: Record<string, unknown>, patch: PersistedAiAccessSettings): void {
  if (body.corsAllowedOrigins === undefined) return;
  if (!Array.isArray(body.corsAllowedOrigins))
    throw new Error('corsAllowedOrigins must be a list of HTTP(S) origins');
  const origins = body.corsAllowedOrigins.map(entry => canonicalOrigin(entry));
  if (origins.some(origin => origin === undefined))
    throw new Error(
      'corsAllowedOrigins must contain only HTTP(S) origins without paths, credentials, queries, or fragments'
    );
  patch.corsAllowedOrigins = [...new Set(origins as string[])];
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
    try {
      parseBooleanField(body, 'enabled', patch);
      parseBooleanField(body, 'allowWithoutAdminAuth', patch);
      parsePositiveIntField(body, 'defaultLinkTtlSeconds', patch);
      parsePositiveIntField(body, 'maxActiveLinks', patch);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message, code: 'invalid_body' });
      return;
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
    try {
      if (body.publicBaseUrl !== undefined)
        patch.publicBaseUrl = validateSettingsPublicBaseUrl(body.publicBaseUrl);
      parseCorsField(body, patch);
      for (const key of [
        'rateLimitWindowMs',
        'rateLimitMaxPerIp',
        'rateLimitMaxPerToken',
      ] as const) {
        parseRateLimitField(body, key, patch);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let url: string | undefined;
    try {
      let target;
      try {
        const settings = RED.settings as { uiPort?: number };
        const server = (
          RED as NodeRedPluginAPI & { server?: { address(): string | { port: number } | null } }
        ).server;
        const address = server?.address();
        const port =
          address && typeof address === 'object' ? address.port : (settings.uiPort ?? 1880);
        target = await preparePublicUrlCheck(
          (req.body as { publicBaseUrl?: unknown } | undefined)?.publicBaseUrl,
          port,
          controller.signal
        );
      } catch (error) {
        if (controller.signal.aborted) throw error;
        res.status(400).json({ error: (error as Error).message, code: 'invalid_body' });
        return;
      }
      url = target.origin + mcpApiBase(RED.settings.httpAdminRoot);
      const status = await requestPublicUrlCheck(
        target,
        mcpApiBase(RED.settings.httpAdminRoot),
        controller.signal
      );
      const result = { status, ok: status >= 200 && status < 300 };
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
