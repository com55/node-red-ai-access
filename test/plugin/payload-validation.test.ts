/**
 * Full-tab payload.flow shape validation, invalid nodes array, unwired scope.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { changedNodeIds, collectFullFlowShapeIssues } from '../../src/plugin/flow-validate.js';
import { registerRoutes } from '../../src/plugin/index.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter, FlowNode, FlowTab } from '../../src/runtime/types.js';

function createApp(userDir: string): { app: Express; linkStore: AccessLinkStore } {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 10 });
  const live: FlowTab = {
    id: 'tab-1',
    type: 'tab',
    label: 'Main',
    nodes: [
      { id: 'n1', type: 'inject', name: 'tick', z: 'tab-1', wires: [['n2']] },
      { id: 'n2', type: 'debug', name: 'out', z: 'tab-1', wires: [[]] },
    ],
    configs: [],
  };
  const adapter: FlowAdapter = {
    kind: 'red',
    getFlows: () =>
      Promise.resolve({
        rev: 'rev-1',
        flows: [
          { id: 'tab-1', type: 'tab', label: 'Main' },
          { id: 'n1', type: 'inject', z: 'tab-1' },
          { id: 'n2', type: 'debug', z: 'tab-1' },
        ],
      }),
    getFlow: () => Promise.resolve({ rev: 'rev-1', flow: structuredClone(live) }),
    updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
  };
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
  registerRoutes(RED, { linkStore, flowAdapter: adapter });
  return { app, linkStore };
}

describe('collectFullFlowShapeIssues', () => {
  it('rejects non-string node id and missing nodes array', () => {
    const badId = collectFullFlowShapeIssues(
      {
        id: 'tab-1',
        nodes: [{ id: {}, type: 'inject' } as unknown as FlowNode],
      },
      'tab-1'
    );
    expect(badId.some(i => i.code === 'missing_node_id')).toBe(true);

    const noNodes = collectFullFlowShapeIssues({ id: 'tab-1' }, 'tab-1');
    expect(noNodes.some(i => i.code === 'invalid_nodes')).toBe(true);
  });

  it('changedNodeIds only includes added/changed', () => {
    const base: Partial<FlowTab> = {
      nodes: [{ id: 'n1', type: 'inject', name: 'a', wires: [[]] }],
    };
    const after: Partial<FlowTab> = {
      nodes: [
        { id: 'n1', type: 'inject', name: 'a', wires: [[]] },
        { id: 'n2', type: 'debug', wires: [[]] },
      ],
    };
    expect([...changedNodeIds(base, after)].sort()).toEqual(['n2']);
  });
});

describe('REST payload.flow / nodes validation', () => {
  let userDir: string;
  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-pv-'));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('rejects payload.nodes string with invalid_nodes (not missing_flow)', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest' });
    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', nodes: 'x' },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_nodes');
    expect(String(res.body.error)).toMatch(/must be an array/i);
  });

  it('rejects full-tab flow with empty/missing shape that would wipe the tab', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest' });
    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', flow: {} },
      });
    expect(res.status).toBe(400);
    expect(['missing_flow_id', 'invalid_nodes', 'validation_failed']).toContain(res.body.code);
  });

  it('rejects node id that is not a string', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest' });
    const res = await request(app)
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
            nodes: [{ id: {}, type: 'inject', wires: [[]] }],
          },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('missing_node_id');
  });

  it('does not unwired_node-warn untouched existing nodes on a rename-only change', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'rest' });
    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'rename-debug',
        payload: {
          flowId: 'tab-1',
          nodes: [{ op: 'set', id: 'n2', set: { name: 'renamed' } }],
        },
      });
    expect(res.status).toBe(201);
    const warnings = (res.body.warnings ?? []) as { code: string; nodeId?: string }[];
    expect(warnings.some(w => w.code === 'unwired_node' && w.nodeId === 'n1')).toBe(false);
  });
});
