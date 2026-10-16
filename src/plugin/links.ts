/**
 * Admin API routes for access-link management.
 */

import type { Response } from 'express';

import {
  AccessLinkLimitError,
  AccessLinkNotFoundError,
  AccessLinkStore,
  AccessLinkValidationError,
  isAccessLinkKind,
} from '../access/index.js';
import type { AccessLinkKind, CreateAccessLinkInput } from '../access/link-store.js';
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
      // get_link: rebuild /mcp/a/… URL for re-copy. rest/mcp: expose raw token
      // for admin Bearer re-copy (token stays create-only for get_link rows).
      if (link.kind === 'get_link') {
        return {
          ...link,
          url: buildAccessLinkUrl(req, RED.settings.httpAdminRoot, token),
        };
      }
      return { ...link, token };
    });
    res.json({ links: active });
  };
}

export function createLinkHandler(RED: NodeRedPluginAPI, store: AccessLinkStore, audit?: AuditLog) {
  return (req: AuthenticatedRequest, res: Response): void => {
    const body = (req.body ?? {}) as {
      ttlSeconds?: unknown;
      label?: unknown;
      kind?: unknown;
    };
    const input: CreateAccessLinkInput = {};

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
    if (body.kind !== undefined) {
      if (!isAccessLinkKind(body.kind)) {
        res.status(400).json({
          error: "kind must be one of: 'get_link', 'rest', 'mcp'",
          code: 'invalid_link_kind',
        });
        return;
      }
      input.kind = body.kind;
    }
    if (typeof req.user?.username === 'string') {
      input.createdBy = req.user.username;
    }

    try {
      const created = storeForRequest(RED, store).create(input);
      const kind: AccessLinkKind = created.kind;
      if (audit) {
        const createdAtMs = Date.parse(created.createdAt);
        const expiresAtMs = Date.parse(created.expiresAt);
        const ttlSeconds =
          Number.isFinite(createdAtMs) && Number.isFinite(expiresAtMs) && expiresAtMs > createdAtMs
            ? Math.round((expiresAtMs - createdAtMs) / 1000)
            : undefined;
        audit.append('link.created', adminActor(req), {
          linkId: created.id,
          label: created.label,
          expiresAt: created.expiresAt,
          createdAt: created.createdAt,
          kind,
          ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
        });
      }
      // Only get_link tokens get a self-contained /mcp/a/… URL (PR B polishes rest/mcp copy).
      if (kind === 'get_link') {
        const url = buildAccessLinkUrl(req, RED.settings.httpAdminRoot, created.token);
        res.status(201).json({ ...created, url });
        return;
      }
      res.status(201).json({ ...created });
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
        const createdAtMs = Date.parse(revoked.createdAt);
        const expiresAtMs = Date.parse(revoked.expiresAt);
        const ttlSeconds =
          Number.isFinite(createdAtMs) && Number.isFinite(expiresAtMs) && expiresAtMs > createdAtMs
            ? Math.round((expiresAtMs - createdAtMs) / 1000)
            : undefined;
        audit.append('link.revoked', adminActor(req), {
          linkId: revoked.id,
          label: revoked.label,
          expiresAt: revoked.expiresAt,
          createdAt: revoked.createdAt,
          kind: revoked.kind,
          ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
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
