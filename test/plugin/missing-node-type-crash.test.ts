/**
 * Regression: GET propose add without type must 400 — never crash Node-RED.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { AiOpsValidationError } from '../../src/plugin/ai-ops.js';
import { registerRoutes } from '../../src/plugin/index.js';
import {
  assertKnownNodeType,
  createStaticNodeTypesAdapter,
  nearestNodeTypes,
  requireNodeTypeName,
} from '../../src/plugin/node-types.js';
import { internalErrorBody, sendCaughtRouteError } from '../../src/plugin/route-errors.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter, FlowTab } from '../../src/runtime/types.js';

function encodePatch(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createApp(userDir: string): { app: Express; linkStore: AccessLinkStore } {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 10, defaultTtlSeconds: 14_400 });
  const flow: FlowTab = {
    id: 'tab-1',
    type: 'tab',
    label: 'Main',
    nodes: [{ id: 'n1', type: 'inject', z: 'tab-1', name: 'In' }],
  };
  const adapter = {
    kind: 'red',
    getFlows: () => Promise.resolve({ rev: 'rev-1', flows: [{ id: 'tab-1', type: 'tab' }] }),
    getFlow: (id: string) =>
      Promise.resolve({
        rev: 'rev-1',
        flow: { ...flow, id, nodes: flow.nodes?.map(n => ({ ...n })) },
      }),
    updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
  } as FlowAdapter;

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir,
      httpAdminRoot: '/',
      adminAuth: { type: 'credentials' },
      aiAccess: { defaultDeploymentType: 'nodes', defaultLinkTtlSeconds: 14_400 },
    },
    httpAdmin: app,
    auth: {
      needsPermission() {
        return (_req: Request, _res: Response, next: NextFunction) => next();
      },
    },
    plugins: {
      registerPlugin() {
        return undefined;
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  registerRoutes(RED, {
    linkStore,
    flowAdapter: adapter,
    nodeTypesAdapter: createStaticNodeTypesAdapter(['inject', 'debug']),
  });
  return { app, linkStore };
}

describe('requireNodeTypeName / nearest safety', () => {
  it('rejects missing, empty, and non-string types', () => {
    expect(() => requireNodeTypeName(undefined)).toThrow(AiOpsValidationError);
    try {
      requireNodeTypeName(undefined);
    } catch (e) {
      expect((e as AiOpsValidationError).code).toBe('missing_node_type');
    }
    try {
      requireNodeTypeName(42);
    } catch (e) {
      expect((e as AiOpsValidationError).code).toBe('invalid_node_type');
    }
    try {
      requireNodeTypeName({ name: 'inject' });
    } catch (e) {
      expect((e as AiOpsValidationError).code).toBe('invalid_node_type');
    }
    expect(requireNodeTypeName('inject')).toBe('inject');
  });

  it('nearestNodeTypes and assertKnownNodeType never call toLowerCase on non-strings', async () => {
    expect(nearestNodeTypes(undefined as unknown as string, ['inject'])).toEqual([]);
    expect(nearestNodeTypes(42 as unknown as string, ['inject'])).toEqual([]);
    const adapter = createStaticNodeTypesAdapter(['inject', 'debug']);
    await expect(assertKnownNodeType(adapter, undefined)).rejects.toMatchObject({
      code: 'missing_node_type',
    });
    await expect(assertKnownNodeType(adapter, 7)).rejects.toMatchObject({
      code: 'invalid_node_type',
    });
  });

  it('internal_error body is stable JSON', () => {
    expect(internalErrorBody(new Error('boom'))).toEqual({
      error: 'boom',
      code: 'internal_error',
    });
  });
});

describe('GET propose add without type does not crash', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-missing-type-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('returns 400 missing_node_type when add omits type', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link', label: 'bot' });
    const patch = encodePatch({
      nodes: [{ op: 'add', node: { id: 'n9', z: 'tab-1', name: 'no-type' } }],
    });
    const res = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&patch=${patch}`
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('missing_node_type');
    expect(res.body.error).toMatch(/type/i);
  });

  it('returns 400 invalid_node_type when type is a number', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link', label: 'bot' });
    const patch = encodePatch({
      nodes: [{ op: 'add', node: { id: 'n9', type: 123, z: 'tab-1' } }],
    });
    const res = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&patch=${patch}`
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_node_type');
  });

  it('returns 400 invalid_node when add.node is a string (not missing_node_type)', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link', label: 'bot' });
    const patch = encodePatch({
      nodes: [{ op: 'add', node: 'notanobject' }],
    });
    const res = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&patch=${patch}`
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_node');
    expect(res.body.code).not.toBe('missing_node_type');
    expect(res.body.error).toMatch(/object/i);
  });

  it('sendCaughtRouteError maps unexpected errors to internal_error without throwing', () => {
    const res = {
      headersSent: false,
      statusCode: 0,
      body: null as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    };
    sendCaughtRouteError(res as never, new TypeError('x.toLowerCase is not a function'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'internal_error' });
  });
});
