/**
 * Minimal Node-RED runtime surface used by the AI Access plugin.
 */

import type { Express, NextFunction, Request, Response } from 'express';

/**
 * Plugin settings read from settings.js (`aiAccess: { ... }`).
 */
export interface AiAccessSettings {
  /**
   * Master switch. When false, AI features stay off even with adminAuth.
   * Default: true. Editable from the editor sidebar AI Access tab.
   */
  enabled?: boolean;
  /**
   * When adminAuth is not configured, AI features stay off unless this is true
   * (intended for local-only setups).
   */
  allowWithoutAdminAuth?: boolean;
  /** Default access-link TTL in seconds (default: 14400 = 4h). */
  defaultLinkTtlSeconds?: number;
  /** Maximum concurrent active access links (default: 10). */
  maxActiveLinks?: number;
  /** Deployment type used when approving proposals (default: nodes). */
  defaultDeploymentType?: 'nodes' | 'flows' | 'full';
  /**
   * Rate-limit window in milliseconds for `/mcp/api` and `/mcp/a`
   * (default: 60000).
   */
  rateLimitWindowMs?: number;
  /**
   * Max requests per IP per window (default: 600 — generous for editor + AI
   * polling).
   */
  rateLimitMaxPerIp?: number;
  /**
   * Max requests per access-link token per window (default: 300).
   */
  rateLimitMaxPerToken?: number;
  /**
   * Explicit public base URL (e.g. `https://nodered.example.com`) used for
   * absolute URLs (access-link `url`, proposal `reviewUrl`, `accessLinksUrl`).
   * Overrides `Host` / `X-Forwarded-*`. Editable in the AI Access settings sidebar unless locked by settings.js.
   */
  publicBaseUrl?: string;
  /**
   * Browser origins allowed to call the AI-facing endpoints (`/mcp/a`,
   * `/mcp/api`, `/mcp/rpc`) cross-origin, e.g. `['https://app.example.com']`.
   * Default: none (no CORS headers). Editable in the AI Access settings sidebar unless locked by settings.js.
   */
  corsAllowedOrigins?: string[];
}

export type AiAccessPermission = 'read' | '*';

export interface AiAccessCapabilities {
  view: boolean;
  manageLinks: boolean;
  approveProposals: boolean;
}

export interface AiAccessStatusCallerAdmin {
  kind: 'admin';
  permission?: AiAccessPermission;
}

export interface AiAccessStatusCallerBaseUrls {
  /** REST API base (`{httpAdminRoot}/mcp/api/v1`). */
  api: string;
  /** MCP Streamable HTTP endpoint (`{httpAdminRoot}/mcp/rpc`). */
  rpc: string;
  /** OpenAPI YAML URL. */
  openapi: string;
  /** OpenAPI JSON URL (same spec as `openapi`). */
  openapiJson: string;
  /** Unauthenticated JSON discovery index. */
  discovery: string;
}

export interface AiAccessStatusCallerAccessLink {
  kind: 'access-link';
  linkId: string;
  /** Token surface this Bearer was minted for (`get_link` | `rest` | `mcp`). */
  tokenKind: AccessLinkKind;
  label?: string;
  /** ISO-8601 expiry of this access link. */
  expiresAt?: string;
  /** Whole minutes until `expiresAt` (0 when already past). */
  /** Whole minutes left, rounded up (never 0 while the token is valid). */
  minutesRemaining?: number;
  /** Whole seconds left, rounded up. */
  secondsRemaining?: number;
  /**
   * Capabilities granted to this access link (not admin scopes).
   * Example: `status:read`, `flows:read`, `proposals:create`, `proposals:read-own`.
   */
  permissions?: string[];
  /**
   * Absolute admin paths this token can use.
   * Surfaces the token cannot call are omitted (not merely marked).
   */
  baseUrls?: Partial<AiAccessStatusCallerBaseUrls>;
}

export type AiAccessStatusCaller = AiAccessStatusCallerAdmin | AiAccessStatusCallerAccessLink;

export interface AiAccessStatus {
  ok: boolean;
  version: string;
  adminAuthEnabled: boolean;
  /** Effective master switch (settings.js / disk). */
  aiAccessEnabled: boolean;
  aiFeaturesEnabled: boolean;
  allowWithoutAdminAuth: boolean;
  /**
   * Admin session permission (`read` / `*`), or `null` for access-link callers
   * (AI tokens are not admin sessions — see `caller`).
   */
  permission: AiAccessPermission | null;
  capabilities: AiAccessCapabilities;
  storageDir?: string;
  /** Effective default access-link TTL (seconds). */
  defaultLinkTtlSeconds: number;
  /** Effective max concurrent active access links. */
  maxActiveLinks: number;
  /** Deployment type used when approving proposals. */
  defaultDeploymentType: 'nodes' | 'flows' | 'full';
  /** Who is calling: admin session or access-link Bearer. */
  caller?: AiAccessStatusCaller;
}

export interface NodeRedPluginSettings {
  userDir: string;
  httpAdminRoot?: string;
  adminAuth?: unknown;
  aiAccess?: AiAccessSettings;
}

export interface NodeRedAuthAPI {
  needsPermission(permission: string): (req: Request, res: Response, next: NextFunction) => void;
}

export interface NodeRedPluginAPI {
  settings: NodeRedPluginSettings;
  httpAdmin: Express;
  auth: NodeRedAuthAPI;
  plugins: {
    registerPlugin: (id: string, definition?: Record<string, unknown>) => void;
  };
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}

export type AccessLinkKind = 'get_link' | 'rest' | 'mcp';

export interface AccessLinkAuthInfo {
  id: string;
  kind: AccessLinkKind;
  label?: string;
  createdAt: string;
  expiresAt: string;
  createdBy?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: {
    username?: string;
    permissions?: string | string[];
  };
  authInfo?: {
    scope?: string | string[];
  };
  /** Set by the Bearer access-link middleware when a valid token is presented. */
  accessLink?: AccessLinkAuthInfo;
}
