/**
 * include_payload alias on GET / REST (parity with MCP include_payload).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import {
  isTruthyFlag,
  parseIncludeQuery,
  resolveIncludeFromQuery,
} from '../../src/plugin/proposal-present.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter } from '../../src/runtime/types.js';

interface MockUser {
  username: string;
  permissions: string | string[];
}

function createApp(userDir: string): { app: Express; linkStore: AccessLinkStore } {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 10 });

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir,
      httpAdminRoot: '/',
      adminAuth: { type: 'credentials' },
      aiAccess: { defaultDeploymentType: 'nodes' },
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

  const adapter: FlowAdapter = {
    kind: 'red',
    getFlows: () =>
      Promise.resolve({
        rev: 'rev-1',
        flows: [
          { id: 'tab-1', type: 'tab', label: 'Main' },
          { id: 'n1', type: 'inject', z: 'tab-1', x: 100, y: 100 },
        ],
      }),
    getFlow: () =>
      Promise.resolve({
        rev: 'rev-1',
        flow: {
          id: 'tab-1',
          type: 'tab',
          label: 'Main',
          nodes: [{ id: 'n1', type: 'inject', z: 'tab-1', x: 100, y: 100 }],
        },
      }),
    updateFlow: () => Promise.resolve({ flowId: 'tab-1', rev: 'rev-2' }),
  };

  registerRoutes(RED, { flowAdapter: adapter, linkStore });
  return { app, linkStore };
}

describe('resolveIncludeFromQuery / include_payload', () => {
  it('parses include= and include_payload alias', () => {
    expect([...parseIncludeQuery('payload')]).toEqual(['payload']);
    expect(isTruthyFlag('true')).toBe(true);
    expect(isTruthyFlag('1')).toBe(true);
    expect(isTruthyFlag('no')).toBe(false);

    const fromAlias = resolveIncludeFromQuery({ include_payload: 'true' });
    expect(fromAlias.has('payload')).toBe(true);
    expect(fromAlias.has('baseFlow')).toBe(true);

    const merged = resolveIncludeFromQuery({ include: 'payload', include_payload: '1' });
    expect(merged.has('payload')).toBe(true);
    expect(merged.has('baseFlow')).toBe(true);
  });
});

describe('include_payload on GET and REST', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-include-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('REST POST ?include_payload=true returns payload and baseFlow', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest', label: 'inc' });

    const lean = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: {
          flowId: 'tab-1',
          flow: {
            id: 'tab-1',
            type: 'tab',
            label: 'Main',
            nodes: [{ id: 'n1', type: 'inject', z: 'tab-1', name: 'A' }],
          },
        },
      });
    expect(lean.status).toBe(201);
    expect(lean.body.payload).toBeUndefined();
    expect(lean.body.baseFlow).toBeUndefined();

    const full = await request(app)
      .post('/mcp/api/v1/proposals?include_payload=true')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: {
          flowId: 'tab-1',
          flow: {
            id: 'tab-1',
            type: 'tab',
            label: 'Main',
            nodes: [{ id: 'n1', type: 'inject', z: 'tab-1', name: 'B' }],
          },
        },
      });
    expect(full.status).toBe(201);
    expect(full.body.payload?.flowId).toBe('tab-1');
    expect(full.body.baseFlow?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'n1' })])
    );

    const got = await request(app)
      .get(`/mcp/api/v1/proposals/${full.body.id}?include_payload=1`)
      .set('Authorization', `Bearer ${link.token}`);
    expect(got.status).toBe(200);
    expect(got.body.payload?.flowId).toBe('tab-1');
    expect(got.body.baseFlow).toBeTruthy();
  });

  it('GET propose ?include_payload=true nests payload under proposal', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link', label: 'get-inc' });

    const lean = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&node=n1&set.name=Lean`
    );
    expect(lean.status).toBe(201);
    expect(lean.body.ok).toBe(true);
    expect(lean.body.proposal).toBeTruthy();
    expect(lean.body.proposal.payload).toBeUndefined();
    expect(lean.body.id).toBeUndefined();

    const full = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&node=n1&set.name=Full&include_payload=true`
    );
    expect(full.status).toBe(201);
    expect(full.body.ok).toBe(true);
    expect(full.body.proposal.payload?.flowId).toBe('tab-1');
    expect(full.body.proposal.baseFlow?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'n1' })])
    );
  });

  it('GET-link docs document propose wrapper vs REST/MCP flat shape', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link', label: 'docs' });
    const docs = await request(app).get(`/mcp/a/${link.token}`);
    expect(docs.status).toBe(200);
    expect(docs.text).toMatch(/GET propose response shape/i);
    expect(docs.text).toMatch(/no `ok` \/ `proposal` wrapper|top level/i);
    expect(docs.text).toMatch(/include_payload/);
  });
});
