/**
 * Admin API routes for access-link management.
 */

import type { Response } from 'express';

import {
  AccessLinkLimitError,
  AccessLinkNotFoundError,
  AccessLinkStore,
  AccessLinkValidationError,
} from '../access/index.js';
import type { AuditLog } from '../storage/audit-log.js';

import { buildAccessLinkUrl, DEFAULT_ACCESS_LINK_TTL_SECONDS } from './access-path.js';
import { resolveAiAccessSettings } from './settings.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

export { DEFAULT_ACCESS_LINK_TTL_SECONDS };

function storeForRequest(RED: NodeRedPluginAPI, store: AccessLinkStore): AccessLinkStore {
  // Limits are fixed at construction; recreate is not needed. Settings are
  // read at plugin load via createConfiguredLinkStore.
  void RED;
  return store;
}

function adminActor(req: AuthenticatedRequest): { kind: 'admin'; username?: string } {
  const username = typeof req.user?.username === 'string' ? req.user.username : undefined;
  return username ? { kind: 'admin', username } : { kind: 'admin' };
}

export function createConfiguredLinkStore(RED: NodeRedPluginAPI): AccessLinkStore {
  const settings = resolveAiAccessSettings(RED.settings);
  return new AccessLinkStore({
    defaultTtlSeconds: settings.defaultLinkTtlSeconds,
    maxActiveLinks: settings.maxActiveLinks,
  });
}

export function listLinksHandler(RED: NodeRedPluginAPI, store: AccessLinkStore) {
  return (req: AuthenticatedRequest, res: Response): void => {
    const linkStore = storeForRequest(RED, store);
    const active = linkStore.list().map(link => {
      const token = linkStore.peekToken(link.id);
      if (!token) {
        return link;
      }
      return {
        ...link,
        url: buildAccessLinkUrl(req, RED.settings.httpAdminRoot, token),
      };
    });
    res.json({ links: active });
  };
}

export function createLinkHandler(RED: NodeRedPluginAPI, store: AccessLinkStore, audit?: AuditLog) {
  return (req: AuthenticatedRequest, res: Response): void => {
    const body = (req.body ?? {}) as { ttlSeconds?: unknown; label?: unknown };
    const input: { ttlSeconds?: number; label?: string; createdBy?: string } = {};

    if (body.ttlSeconds !== undefined) {
      if (typeof body.ttlSeconds !== 'number') {
        res.status(400).json({ error: 'ttlSeconds must be a positive number' });
        return;
      }
      input.ttlSeconds = body.ttlSeconds;
    }
    if (typeof body.label === 'string') {
      input.label = body.label;
    }
    if (typeof req.user?.username === 'string') {
      input.createdBy = req.user.username;
    }

    try {
      const created = storeForRequest(RED, store).create(input);
      const url = buildAccessLinkUrl(req, RED.settings.httpAdminRoot, created.token);
      if (audit) {
        audit.append('link.created', adminActor(req), {
          linkId: created.id,
          label: created.label,
          expiresAt: created.expiresAt,
        });
      }
      res.status(201).json({ ...created, url });
    } catch (error) {
      if (error instanceof AccessLinkLimitError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof AccessLinkValidationError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  };
}

export function revokeLinkHandler(RED: NodeRedPluginAPI, store: AccessLinkStore, audit?: AuditLog) {
  return (req: AuthenticatedRequest, res: Response): void => {
    const linkId = req.params.id;
    if (typeof linkId !== 'string' || linkId.length === 0) {
      res.status(400).json({ error: 'Missing link id' });
      return;
    }

    try {
      const revoked = storeForRequest(RED, store).revoke(linkId);
      if (audit) {
        audit.append('link.revoked', adminActor(req), {
          linkId: revoked.id,
          label: revoked.label,
        });
      }
      res.json({ revoked: true, link: revoked });
    } catch (error) {
      if (error instanceof AccessLinkNotFoundError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  };
}
