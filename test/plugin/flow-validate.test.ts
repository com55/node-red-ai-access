/**
 * Soft validation: hard-reject only excess/nonexistent wire ports;
 * missing config + unwired/incomplete wires are warnings[].
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import {
  wrongTokenKindHint,
  whatToTellUserWrongTokenKind,
} from '../../src/plugin/access-link-auth.js';
import {
  collectWireIssues,
  collectWireValidation,
  throwValidationIssues,
  validateFlowTab,
  wireCountIssue,
} from '../../src/plugin/flow-validate.js';
import { registerRoutes } from '../../src/plugin/index.js';
import { createStaticNodeTypesAdapter } from '../../src/plugin/node-types.js';
import { describeWiresStructured } from '../../src/plugin/proposal-diff.js';
import { baseUrlsForTokenKind } from '../../src/plugin/status.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter, FlowNode, FlowTab } from '../../src/runtime/types.js';

const DEBUG_HTML = `
<script type="text/javascript">
  RED.nodes.registerType('debug',{
    category: 'output',
    defaults: { name: {value:""} },
    inputs:1,
    outputs:0
  });
</script>
`;

const MQTT_HTML = `
<script type="text/javascript">
  RED.nodes.registerType('mqtt in',{
    category: 'input',
    defaults: {
      name: {value:""},
      broker: {type:"mqtt-broker", required:true}
    },
    inputs:0,
    outputs:1
  });
</script>
`;

const INJECT_HTML = `
<script type="text/javascript">
  RED.nodes.registerType('inject',{
    category: 'input',
    defaults: { name: {value:""} },
    inputs:0,
    outputs:1
  });
</script>
`;

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
    nodes: [{ id: 'n1', type: 'inject', z: 'tab-1', name: 'In', wires: [[]] }],
    configs: [{ id: 'broker1', type: 'mqtt-broker', name: 'Local' }],
  };
  const adapter = {
    kind: 'red',
    getFlows: () => Promise.resolve({ rev: 'rev-1', flows: [{ id: 'tab-1', type: 'tab' }] }),
    getFlow: (id: string) =>
      Promise.resolve({
        rev: 'rev-1',
        flow: {
          ...flow,
          id,
          nodes: flow.nodes?.map(n => ({ ...n })),
          configs: flow.configs?.map(c => ({ ...c })),
        },
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
    nodeTypesAdapter: createStaticNodeTypesAdapter(
      ['inject', 'debug', 'mqtt in', 'mqtt-broker', 'function'],
      {
        configs: {
          debug: DEBUG_HTML,
          inject: INJECT_HTML,
          'mqtt in': MQTT_HTML,
        },
      }
    ),
  });
  return { app, linkStore };
}

describe('wire output count + structured wires', () => {
  it('wireCountIssue: debug has 0 outputs; wires must be []', () => {
    const node = { id: 'd1', type: 'debug' } as FlowNode;
    expect(wireCountIssue(node, 0, [[]])?.error).toMatch(/debug has 0 outputs; wires must be \[\]/);
    expect(wireCountIssue(node, 0, [])).toBeUndefined();
  });

  it('wireCountIssue: fewer ports than outputs is not an error', () => {
    const node = { id: 'f1', type: 'function' } as FlowNode;
    expect(wireCountIssue(node, 2, [[]])).toBeUndefined();
    expect(wireCountIssue(node, 2, [])).toBeUndefined();
  });

  it('collectWireIssues rejects extra ports vs registry outputs', async () => {
    const adapter = createStaticNodeTypesAdapter(['debug'], { configs: { debug: DEBUG_HTML } });
    const issues = await collectWireIssues([{ id: 'd1', type: 'debug', wires: [['x']] }], adapter);
    expect(issues.some(i => i.code === 'invalid_wires' && i.error.includes('0 outputs'))).toBe(
      true
    );
  });

  it('collectWireValidation soft-warns incomplete / unwired; errors only on excess', async () => {
    const adapter = createStaticNodeTypesAdapter(['function', 'debug', 'inject'], {
      configs: { debug: DEBUG_HTML, inject: INJECT_HTML },
    });
    const soft = await collectWireValidation(
      [
        { id: 'f1', type: 'function', outputs: 2, wires: [['n2']] },
        { id: 'n2', type: 'debug', wires: [] },
        { id: 'inj', type: 'inject', wires: [[]] },
      ],
      adapter
    );
    expect(soft.errors.filter(i => i.code === 'invalid_wires')).toEqual([]);
    expect(soft.warnings.some(w => w.code === 'incomplete_wires' && w.nodeId === 'f1')).toBe(true);
    expect(soft.warnings.some(w => w.code === 'unwired_node' && w.nodeId === 'inj')).toBe(true);

    const hard = await collectWireValidation(
      [{ id: 'f1', type: 'function', outputs: 1, wires: [[], []] }],
      adapter
    );
    expect(hard.errors.some(e => e.code === 'invalid_wires' && e.error.includes('1 outputs'))).toBe(
      true
    );
  });

  it('uses node.outputs for function over registry', async () => {
    const adapter = createStaticNodeTypesAdapter(['function']);
    const ok = await collectWireIssues(
      [
        {
          id: 'f1',
          type: 'function',
          outputs: 2,
          wires: [[], ['n2']],
        },
        { id: 'n2', type: 'debug', wires: [] },
      ],
      adapter
    );
    expect(ok.filter(i => i.code === 'invalid_wires')).toEqual([]);

    const bad = await collectWireIssues(
      [{ id: 'f1', type: 'function', outputs: 1, wires: [[], []] }],
      adapter
    );
    expect(bad.some(i => i.error.includes('1 outputs'))).toBe(true);
  });

  it('describeWiresStructured returns port/to objects', () => {
    const nodes = new Map<string, FlowNode>([['n2', { id: 'n2', type: 'debug', name: 'out' }]]);
    expect(describeWiresStructured({ id: 'n1', type: 'inject', wires: [['n2']] }, nodes)).toEqual([
      { port: 0, to: [{ id: 'n2', name: 'out' }] },
    ]);
  });
});

describe('required config nodes (soft warnings)', () => {
  it('validateFlowTab returns missing_config_node in warnings[], never errors', async () => {
    const adapter = createStaticNodeTypesAdapter(['mqtt in', 'mqtt-broker'], {
      configs: { 'mqtt in': MQTT_HTML },
    });
    const { errors, warnings } = await validateFlowTab(
      {
        id: 'tab-1',
        type: 'tab',
        nodes: [{ id: 'm1', type: 'mqtt in', z: 'tab-1', wires: [[]] }],
        configs: [{ id: 'broker1', type: 'mqtt-broker' }],
      },
      { flowId: 'tab-1', nodeTypes: adapter }
    );
    expect(errors.some(e => e.code === 'missing_config_node')).toBe(false);
    expect(warnings.some(w => w.code === 'missing_config_node')).toBe(true);
    const miss = warnings.find(w => w.code === 'missing_config_node');
    expect(miss?.candidates).toContain('broker1');
  });
});

describe('multi-error accumulation', () => {
  it('throwValidationIssues includes every error in errors[]', () => {
    try {
      throwValidationIssues([
        { code: 'invalid_wires', error: 'wires bad', nodeId: 'a' },
        { code: 'z_mismatch', error: 'z bad', nodeId: 'b' },
      ]);
      expect.unreachable();
    } catch (e) {
      const err = e as {
        code: string;
        message: string;
        details?: { errors?: unknown[]; errorCount?: number };
      };
      // Primary code/message come from the first issue (not a generic batch label).
      expect(err.code).toBe('invalid_wires');
      expect(err.message).toBe('wires bad');
      expect(err.details?.errors).toHaveLength(2);
      expect(err.details?.errorCount).toBe(2);
    }
  });
});

describe('status tokenKind + wrong_token_kind hint', () => {
  it('baseUrlsForTokenKind omits surfaces the token cannot use', () => {
    expect(baseUrlsForTokenKind('rest', '/')).toEqual({
      api: '/mcp/api/v1',
      openapi: '/mcp/api/v1/openapi.yaml',
      discovery: '/mcp/api/v1',
    });
    expect(baseUrlsForTokenKind('mcp', '/')).toEqual({
      rpc: '/mcp/rpc',
      discovery: '/mcp/api/v1',
    });
    expect(baseUrlsForTokenKind('get_link', '/')).toEqual({
      discovery: '/mcp/api/v1',
    });
  });

  it('wrongTokenKindHint points at Access links mint and tellUser', () => {
    const hint = wrongTokenKindHint('rest', 'get_link');
    expect(hint).toMatch(/Access links/);
    expect(hint).toMatch(/kind=rest\/mcp/);
    expect(whatToTellUserWrongTokenKind('rest')).toMatch(/Access links/);
  });
});

describe('GET propose soft vs hard validation', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-flow-val-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('rejects debug wires with a port when outputs=0', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link', label: 'bot' });
    const patch = encodePatch({
      nodes: [
        {
          op: 'add',
          node: { id: 'd9', type: 'debug', z: 'tab-1', name: 'out', wires: [['n1']] },
        },
      ],
    });
    const res = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&patch=${patch}`
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toMatch(/invalid_wires|validation_failed/);
    expect(JSON.stringify(res.body)).toMatch(/0 outputs/);
  });

  it('accepts mqtt in without broker and returns warnings[]', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link', label: 'bot' });
    const patch = encodePatch({
      nodes: [
        {
          op: 'add',
          node: { id: 'm9', type: 'mqtt in', z: 'tab-1', name: 'topic', wires: [['n1']] },
        },
      ],
    });
    const res = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&patch=${patch}`
    );
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect(res.body.warnings.some((w: { code: string }) => w.code === 'missing_config_node')).toBe(
      true
    );
    expect(
      res.body.proposal?.warnings?.some((w: { code: string }) => w.code === 'missing_config_node')
    ).toBe(true);
    // Hard error path must not use missing_config_node
    expect(res.body.code).toBeUndefined();
    expect(res.body.errors).toBeUndefined();

    const diff = await request(app).get(
      `/mcp/a/${link.token}/proposals/${res.body.proposal.id}/diff`
    );
    expect(diff.status).toBe(200);
    expect(
      diff.body.warnings?.some((w: { code: string }) => w.code === 'missing_config_node')
    ).toBe(true);
  });

  it('returns errors[] for z_mismatch together with other issues', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'get_link', label: 'bot' });
    const patch = encodePatch({
      nodes: [
        {
          op: 'add',
          node: {
            id: 'd9',
            type: 'debug',
            z: 'other-tab',
            wires: [['missing']],
          },
        },
      ],
    });
    const res = await request(app).get(
      `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&patch=${patch}`
    );
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThanOrEqual(2);
  });
});
