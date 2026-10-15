/**
 * Minimal Node-RED runtime surface used by the AI Access plugin.
 */

import type { Express, NextFunction, Request, Response } from 'express';

/**
 * Plugin settings read from settings.js (`aiAccess: { ... }`).
 * Fields beyond allowWithoutAdminAuth are reserved for later PRs.
 */
export interface AiAccessSettings {
  /**
   * When adminAuth is not configured, AI features stay off unless this is true
   * (intended for local-only setups).
   */
  allowWithoutAdminAuth?: boolean;
  /** Reserved: default access-link TTL in seconds (planned default: 86400). */
  defaultLinkTtlSeconds?: number;
  /** Reserved: maximum concurrent active access links (planned default: 10). */
  maxActiveLinks?: number;
  /** Reserved: deployment type used when approving proposals. */
  defaultDeploymentType?: 'nodes' | 'flows' | 'full';
}

export type AiAccessPermission = 'read' | '*';

export interface AiAccessCapabilities {
  view: boolean;
  manageLinks: boolean;
  approveProposals: boolean;
}

export interface AiAccessStatus {
  ok: boolean;
  version: string;
  adminAuthEnabled: boolean;
  aiFeaturesEnabled: boolean;
  allowWithoutAdminAuth: boolean;
  permission: AiAccessPermission | null;
  capabilities: AiAccessCapabilities;
  storageDir: string;
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

export interface AuthenticatedRequest extends Request {
  user?: {
    username?: string;
    permissions?: string | string[];
  };
  authInfo?: {
    scope?: string | string[];
  };
}
