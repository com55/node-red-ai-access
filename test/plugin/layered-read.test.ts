/**
 * Layered reads: flow summary, one node, field line range, text search.
 * Covered on helpers + GET link + REST (MCP tools share the same helpers).
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
  DEFAULT_SEARCH_RESULT_CAP,
  getFlowSummary,
  getNodeById,
  getNodeField,
  parseLineRange,
  searchFlows,
} from '../../src/plugin/layered-read.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter, FlowTab } from '../../src/runtime/types.js';

const LONG_FUNC = ['line1', 'line2 TODO here', 'line3', 'line4 more TODO', 'line5 end'].join('\n');

function sampleFlow(): FlowTab {
  return {
    id: 'tab-1',
    type: 'tab',
    label: 'Main',
    nodes: [
      {
        id: 'n1',
        type: 'template',
        z: 'tab-1',
        name: 'Tpl',
        wires: [['n2']],
        template: '<p>Hello</p>\n<p>World</p>\n<p>TODO</p>',
      },
      {
        id: 'n2',
        type: 'function',
        z: 'tab-1',
        name: 'Fn',
        wires: [[]],
        func: LONG_FUNC,
      },
    ],
  };
}

function createAdapter(flow: FlowTab = sampleFlow()): FlowAdapter {
  return {
    kind: 'red',
    getFlows: () =>
      Promise.resolve({ rev: 'rev-1', flows: [{ id: 'tab-1', type: 'tab', label: 'Main' }] }),
    getFlow: (id: string) =>
      Promise.resolve({
        rev: 'rev-1',
        flow: { ...flow, id, nodes: flow.nodes?.map(n => ({ ...n })) },
      }),
    updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
  } as FlowAdapter;
}

function createApp(
  userDir: string,
  adapter?: FlowAdapter
): {
  app: Express;
  linkStore: AccessLinkStore;
  adapter: FlowAdapter;
} {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 10, defaultTtlSeconds: 14_400 });
  const flowAdapter = adapter ?? createAdapter();
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
  registerRoutes(RED, { linkStore, flowAdapter });
  return { app, linkStore, adapter: flowAdapter };
}

describe('parseLineRange', () => {
  it('parses A and A-B', () => {
    expect(parseLineRange('3')).toEqual({ start: 3, end: 3 });
    expect(parseLineRange('2-4')).toEqual({ start: 2, end: 4 });
    expect(parseLineRange(undefined)).toBeUndefined();
  });

  it('rejects invalid ranges', () => {
    expect(() => parseLineRange('0-1')).toThrow(AiOpsValidationError);
    expect(() => parseLineRange('4-2')).toThrow(AiOpsValidationError);
    expect(() => parseLineRange('abc')).toThrow(AiOpsValidationError);
  });
});

describe('layered-read helpers', () => {
  it('getFlowSummary omits field contents and reports bytes', async () => {
    const summary = await getFlowSummary(createAdapter(), 'tab-1');
    expect(summary).toMatchObject({
      rev: 'rev-1',
      flowId: 'tab-1',
      label: 'Main',
      nodeCount: 2,
    });
    expect(summary.nodes).toHaveLength(2);
    const n1 = summary.nodes.find(n => n.id === 'n1');
    expect(n1).toMatchObject({ id: 'n1', type: 'template', name: 'Tpl' });
    expect(n1?.wires).toEqual([['n2']]);
    expect(typeof n1?.bytes).toBe('number');
    expect(n1!.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toMatch(/Hello|TODO|line1/);
  });

  it('getNodeById returns full node with flowId', async () => {
    const got = await getNodeById(createAdapter(), 'n2', 'tab-1');
    expect(got.flowId).toBe('tab-1');
    expect(got.node).toMatchObject({ id: 'n2', type: 'function', func: LONG_FUNC });
  });

  it('getNodeField returns slice with totalLines and bytes', async () => {
    const full = await getNodeField(createAdapter(), 'n2', 'func', { flowId: 'tab-1' });
    expect(full.totalLines).toBe(5);
    expect(full.bytes).toBe(Buffer.byteLength(LONG_FUNC, 'utf8'));
    expect(full.value).toBe(LONG_FUNC);
    expect(full.lineRange).toBeUndefined();

    const slice = await getNodeField(createAdapter(), 'n2', 'func', {
      flowId: 'tab-1',
      lines: '2-3',
    });
    expect(slice.value).toBe('line2 TODO here\nline3');
    expect(slice.lineRange).toEqual({ start: 2, end: 3 });
    expect(slice.totalLines).toBe(5);
  });

  it('searchFlows returns hits with lines/snippet and respects cap', async () => {
    const result = await searchFlows(createAdapter(), 'TODO', { flowId: 'tab-1' });
    expect(result.truncated).toBe(false);
    expect(result.cap).toBe(DEFAULT_SEARCH_RESULT_CAP);
    expect(result.hitCount).toBeGreaterThanOrEqual(2);
    const hit = result.hits.find(h => h.nodeId === 'n2' && h.field === 'func');
    expect(hit?.lines).toEqual(expect.arrayContaining([2, 4]));
    expect(hit?.snippet).toMatch(/TODO/);

    const capped = await searchFlows(createAdapter(), 'TODO', { flowId: 'tab-1', cap: 1 });
    expect(capped.truncated).toBe(true);
    expect(capped.hitCount).toBe(1);
    expect(capped.cap).toBe(1);
  });
});

describe('GET link + REST layered reads', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-layered-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('GET link summary / node / field / search', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ label: 'lr' });
    const base = `/mcp/a/${link.token}`;

    const summary = await request(app).get(`${base}/flows/tab-1?summary=1`);
    expect(summary.status).toBe(200);
    expect(summary.headers['cache-control']).toMatch(/no-store/);
    expect(summary.body.nodeCount).toBe(2);
    expect(summary.body.nodes[0]).toMatchObject({ id: 'n1', type: 'template' });
    expect(summary.body.nodes[0].template).toBeUndefined();

    const full = await request(app).get(`${base}/flows/tab-1`);
    expect(full.status).toBe(200);
    expect(full.body.flow?.nodes?.[0]?.template).toMatch(/Hello/);

    const node = await request(app).get(`${base}/nodes/n1`);
    expect(node.status).toBe(200);
    expect(node.body).toMatchObject({ flowId: 'tab-1', node: { id: 'n1', type: 'template' } });
    expect(node.body.node.template).toMatch(/Hello/);

    const field = await request(app).get(`${base}/nodes/n2/field/func?lines=2-2`);
    expect(field.status).toBe(200);
    expect(field.body).toMatchObject({
      nodeId: 'n2',
      field: 'func',
      value: 'line2 TODO here',
      totalLines: 5,
      lineRange: { start: 2, end: 2 },
    });
    expect(typeof field.body.bytes).toBe('number');

    const search = await request(app).get(`${base}/search?q=TODO&flow=tab-1`);
    expect(search.status).toBe(200);
    expect(search.body.truncated).toBe(false);
    expect(search.body.hits.length).toBeGreaterThanOrEqual(1);
    expect(search.body.hits[0]).toMatchObject({
      nodeId: expect.any(String),
      field: expect.any(String),
      lines: expect.any(Array),
      snippet: expect.any(String),
    });

    const missingQ = await request(app).get(`${base}/search`);
    expect(missingQ.status).toBe(400);
    expect(missingQ.body.code).toBe('missing_query');
  });

  it('REST Bearer uses the same layered read routes', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ label: 'rest-lr' });
    const auth = { Authorization: `Bearer ${link.token}` };

    const summary = await request(app).get('/mcp/api/v1/flows/tab-1?summary=1').set(auth);
    expect(summary.status).toBe(200);
    expect(summary.body.nodes).toHaveLength(2);

    const node = await request(app).get('/mcp/api/v1/nodes/n1?flow=tab-1').set(auth);
    expect(node.status).toBe(200);
    expect(node.body.node.id).toBe('n1');

    const field = await request(app).get('/mcp/api/v1/nodes/n1/field/template?lines=1-1').set(auth);
    expect(field.status).toBe(200);
    expect(field.body.value).toBe('<p>Hello</p>');
    expect(field.body.totalLines).toBe(3);

    const search = await request(app).get('/mcp/api/v1/search?q=World').set(auth);
    expect(search.status).toBe(200);
    expect(search.body.hits.some((h: { nodeId: string }) => h.nodeId === 'n1')).toBe(true);

    const missing = await request(app).get('/mcp/api/v1/nodes/nope').set(auth);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('node_not_found');
  });

  it('AI guide documents the layered-read workflow', async () => {
    const { readFileSync } = await import('node:fs');
    const docs = readFileSync(join(process.cwd(), 'src/plugin/get-link/docs.ts'), 'utf8');
    expect(docs).toMatch(/summary=1/);
    expect(docs).toMatch(/search\?q=/);
    expect(docs).toMatch(/nodes\/<id>\/field/);
    expect(docs).toMatch(/summary → search → read a line range/);
    expect(docs).toMatch(/replace_text/);
  });

  it('discovery index lists layered-read endpoints', async () => {
    const { app } = createApp(userDir);
    const res = await request(app).get('/mcp/api/v1');
    expect(res.status).toBe(200);
    const paths = (res.body.endpoints as { path: string }[]).map(e => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(['/flows/{id}', '/nodes/{id}', '/nodes/{id}/field/{name}', '/search'])
    );
  });
});
