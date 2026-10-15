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
  /** Default access-link TTL in seconds (default: 86400). */
  defaultLinkTtlSeconds?: number;
  /** Maximum concurrent active access links (default: 10). */
  maxActiveLinks?: number;
  /** Deployment type used when approving proposals (default: nodes). */
  defaultDeploymentType?: 'nodes' | 'flows' | 'full';
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

export interface AiAccessStatusCallerAccessLink {
  kind: 'access-link';
  linkId: string;
  label?: string;
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
  storageDir: string;
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

export interface AccessLinkAuthInfo {
  id: string;
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
