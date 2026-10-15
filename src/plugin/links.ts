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

import { resolveAiAccessSettings } from './settings.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

function storeForRequest(RED: NodeRedPluginAPI, store: AccessLinkStore): AccessLinkStore {
  // Limits are fixed at construction; recreate is not needed. Settings are
  // read at plugin load via createConfiguredLinkStore.
  void RED;
  return store;
}

export function createConfiguredLinkStore(RED: NodeRedPluginAPI): AccessLinkStore {
  const settings = resolveAiAccessSettings(RED.settings);
  return new AccessLinkStore({
    defaultTtlSeconds: settings.defaultLinkTtlSeconds,
    maxActiveLinks: settings.maxActiveLinks,
  });
}

export function listLinksHandler(RED: NodeRedPluginAPI, store: AccessLinkStore) {
  return (_req: AuthenticatedRequest, res: Response): void => {
    const active = storeForRequest(RED, store).list();
    res.json({ links: active });
  };
}

export function createLinkHandler(RED: NodeRedPluginAPI, store: AccessLinkStore) {
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
      res.status(201).json(created);
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

export function revokeLinkHandler(RED: NodeRedPluginAPI, store: AccessLinkStore) {
  return (req: AuthenticatedRequest, res: Response): void => {
    const linkId = req.params.id;
    if (typeof linkId !== 'string' || linkId.length === 0) {
      res.status(400).json({ error: 'Missing link id' });
      return;
    }

    try {
      const revoked = storeForRequest(RED, store).revoke(linkId);
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
