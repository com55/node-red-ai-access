/**
 * Admin GET/PUT /mcp/api/v1/settings — editable AI Access configuration.
 */

import type { Response } from 'express';

import type { AccessLinkStore } from '../access/link-store.js';
import type { PersistedAiAccessSettings, SettingsStore } from '../storage/settings-store.js';
import { StoragePayloadTooLargeError } from '../storage/trusted-write.js';

import { bindPublicBaseUrl, canonicalizeIp, validateSettingsPublicBaseUrl } from './access-path.js';
import { dashboardPath, describeAccess, mcpApiBase } from './auth.js';
import { canonicalOrigin } from './cors.js';
import {
  classifyPublicUrlAddress,
  preparePublicUrlCheck,
  requestPublicUrlCheck,
} from './public-url-check.js';
import { sendCaughtRouteError } from './route-errors.js';
import {
  DEFAULT_SECRET_NAME_PATTERNS,
  MAX_SECRET_NAME_PATTERNS,
  normalizeSecretNamePatterns,
  SECRET_NAME_PATTERN_RE,
} from './secret-patterns.js';
import { isAdminAuthEnabled } from './settings.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

function mcpPageUrl(RED: NodeRedPluginAPI): string {
  return dashboardPath(RED.settings.httpAdminRoot);
}

function normalizeTrustProxy(value: unknown): boolean | number | string {
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
    return value;
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'function' ? 'custom function' : false;
}

function oauthPublicUrlWarning(publicBaseUrl: string): string | null {
  if (!publicBaseUrl) return 'Set a Public URL before enabling OAuth.';
  const url = new URL(publicBaseUrl);
  const ip = canonicalizeIp(url.hostname);
  const local =
    url.hostname.toLowerCase().replace(/\.$/, '') === 'localhost' ||
    ip === '::1' ||
    ip?.startsWith('127.');
  return url.protocol === 'http:' && !local
    ? 'OAuth Public URL uses HTTP; HTTPS is recommended.'
    : null;
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
    oauthPublicUrlWarning: oauthPublicUrlWarning(settings.publicBaseUrl),
    sources,
    disk: store.getDisk(),
    trustProxy: normalizeTrustProxy(req.app.get('trust proxy')),
    precedence: ['settings.js', 'disk', 'default'] as const,
    defaults: { secretNamePatterns: [...DEFAULT_SECRET_NAME_PATTERNS] },
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
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new Error(`${key} must be an integer with a minimum of 1`);
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

function parseSecretPatternsField(
  body: Record<string, unknown>,
  patch: PersistedAiAccessSettings,
  reset: (keyof PersistedAiAccessSettings)[]
): void {
  const value = body.secretNamePatterns;
  if (value === undefined) return;
  if (value === null) {
    reset.push('secretNamePatterns');
    return;
  }
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string'))
    throw new Error('secretNamePatterns must be a list of strings (or null to reset)');
  if (value.length > MAX_SECRET_NAME_PATTERNS)
    throw new Error(`secretNamePatterns allows at most ${MAX_SECRET_NAME_PATTERNS} entries`);
  for (const entry of value as string[]) {
    if (!SECRET_NAME_PATTERN_RE.test(entry.trim()))
      throw new Error(
        'secretNamePatterns entries must be 2-40 letters, digits, "_" or "-" (e.g. API_KEY)'
      );
  }
  patch.secretNamePatterns = normalizeSecretNamePatterns(value) ?? [];
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
    if (store.getEffective().sources.oauth === 'settings.js') delete body.oauth;

    const patch: PersistedAiAccessSettings = {};
    const reset: (keyof PersistedAiAccessSettings)[] = [];
    try {
      if (body.proposalTtlDays !== undefined) {
        const value = body.proposalTtlDays;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 365)
          throw new Error('proposalTtlDays must be an integer between 1 and 365');
        patch.proposalTtlDays = value;
      }
      if (body.oauth !== undefined) {
        if (!body.oauth || typeof body.oauth !== 'object' || Array.isArray(body.oauth))
          throw new Error('oauth must be an object');
        const value = body.oauth as Record<string, unknown>;
        const oauth: NonNullable<PersistedAiAccessSettings['oauth']> = {};
        if (value.enabled !== undefined) {
          if (typeof value.enabled !== 'boolean')
            throw new Error('oauth.enabled must be a boolean');
          oauth.enabled = value.enabled;
        }
        for (const key of ['accessTokenTtlSec', 'refreshIdleTtlSec', 'dcrMaxClients'] as const) {
          if (value[key] !== undefined) {
            if (
              typeof value[key] !== 'number' ||
              !Number.isInteger(value[key]) ||
              value[key] < 1 ||
              value[key] > 31_536_000
            )
              throw new Error(`oauth.${key} must be an integer with a minimum of 1`);
            oauth[key] = value[key];
          }
        }
        const max = value.refreshMaxLifetimeSec;
        if (max !== undefined) {
          if (typeof max !== 'number' || !Number.isInteger(max) || max < 0 || max > 315_360_000)
            throw new Error('oauth.refreshMaxLifetimeSec must be a non-negative integer');
          oauth.refreshMaxLifetimeSec = max;
        }
        patch.oauth = oauth;
      }
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
      parseSecretPatternsField(body, patch, reset);
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
      const effective = store.patch(patch, reset);
      bindPublicBaseUrl(effective.publicBaseUrl);
      linkStore.configureDefaults({
        defaultTtlSeconds: effective.defaultLinkTtlSeconds,
        maxActiveLinks: effective.maxActiveLinks,
      });
      const response = settingsResponse(RED, store, req);
      const publicUrl = effective.publicBaseUrl ? new URL(effective.publicBaseUrl) : undefined;
      const literal = publicUrl
        ? canonicalizeIp(publicUrl.hostname.replace(/^\[|\]$/g, ''))
        : undefined;
      const addressClass = literal ? classifyPublicUrlAddress(literal) : undefined;
      const warnings: string[] = [];
      if (addressClass !== undefined && addressClass !== 'public')
        warnings.push('Public URL uses a private or non-public IP address.');
      const oauthWarning = oauthPublicUrlWarning(effective.publicBaseUrl);
      if (oauthWarning && effective.publicBaseUrl) warnings.push(oauthWarning);
      res.json({
        ...response,
        ...(warnings.length ? { warnings } : {}),
      });
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
        const value = (req.body as { publicBaseUrl?: unknown } | undefined)?.publicBaseUrl;
        const host = typeof value === 'string' ? new URL(value.trim()).hostname : '';
        const loopback =
          host
            .toLowerCase()
            .replace(/^\[|\]$/g, '')
            .replace(/\.$/, '') === 'localhost' ||
          classifyPublicUrlAddress(host.replace(/^\[|\]$/g, '')) === 'loopback';
        if (loopback && typeof address === 'string') {
          throw new Error(
            'Public URL Check does not support loopback URLs when Node-RED listens on a Unix socket'
          );
        }
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
