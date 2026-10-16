/**
 * Node-types discovery, palette search (recommend-only), and unknown_node_type validation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { AiOpsValidationError } from '../../src/plugin/ai-ops.js';
import { renderGetLinkDocs } from '../../src/plugin/get-link/docs.js';
import { registerRoutes } from '../../src/plugin/index.js';
import {
  assertKnownNodeTypes,
  createStaticNodeTypesAdapter,
  getNodeTypeDetail,
  listNodeTypes,
  nearestNodeTypes,
  paletteMatchScore,
  parseRegisterTypeFromHtml,
  resetCatalogueCache,
  searchPalette,
  type CatalogueFetcher,
  type NodeTypesAdapter,
} from '../../src/plugin/node-types.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter, FlowTab } from '../../src/runtime/types.js';

const SAMPLE_HTML = `
<script type="text/javascript">
  RED.nodes.registerType('inject',{
    category: 'input',
    color: '#a6bbcf',
    defaults: {
      name: {value:""},
      topic: {value:""},
      broker: {type:"mqtt-broker", required:true}
    },
    inputs:0,
    outputs:1
  });
</script>
<script type="text/markdown" data-help-name="inject">
Inject a message into a flow.
</script>
`;

function sampleFlow(): FlowTab {
  return {
    id: 'tab-1',
    type: 'tab',
    label: 'Main',
    nodes: [
      { id: 'n1', type: 'inject', z: 'tab-1', name: 'In', wires: [['n2']] },
      { id: 'n2', type: 'debug', z: 'tab-1', name: 'Out', wires: [[]] },
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

function mockCatalogueFetcher(): CatalogueFetcher {
  return async () => ({
    status: 200,
    etag: '"cat-1"',
    body: {
      modules: [
        {
          id: 'node-red-contrib-foo',
          description: 'Foo helpers for flows',
          version: '1.2.3',
          updated_at: '2024-01-01',
          keywords: ['foo', 'helper'],
          url: 'https://flows.nodered.org/node/node-red-contrib-foo',
          downloads: 42,
        },
        {
          id: 'node-red',
          description: 'Node-RED core',
          version: '4.0.0',
          updated_at: '2024-06-01',
          url: 'https://nodered.org',
        },
        {
          id: 'node-red-contrib-modbus',
          description: 'Modbus serial and TCP nodes',
          version: '5.0.0',
          updated_at: '2024-03-01',
          keywords: ['modbus', 'serial'],
          url: 'https://flows.nodered.org/node/node-red-contrib-modbus',
          // Lower downloads than stacked-keyword decoys — exact suffix must still win.
          downloads: 100,
        },
        {
          id: 'node-red-contrib-something-else',
          description: 'Mentions modbus only in the long description as a random aside',
          version: '0.1.0',
          updated_at: '2024-02-01',
          keywords: ['unrelated'],
          url: 'https://flows.nodered.org/node/node-red-contrib-something-else',
          downloads: 1,
        },
        // Decoys: keyword stacking + huge downloads must not beat exact package suffix.
        ...Array.from({ length: 12 }, (_, i) => ({
          id: `node-red-contrib-industrial-modbus-kit-${i}`,
          description: `Industrial modbus toolkit number ${i} with modbus helpers`,
          version: '9.0.0',
          keywords: ['modbus', 'modbus-tcp', 'modbus-serial', 'modbus-rtu', 'plc'],
          downloads: 50_000 + i,
        })),
        {
          id: 'node-red-contrib-bar',
          description: 'Unrelated bar module',
          version: '0.1.0',
          keywords: ['bar'],
        },
      ],
    },
  });
}

function createApp(options: {
  userDir: string;
  adapter?: FlowAdapter;
  nodeTypesAdapter?: NodeTypesAdapter;
  catalogueFetcher?: CatalogueFetcher;
}): {
  app: Express;
  linkStore: AccessLinkStore;
} {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 10, defaultTtlSeconds: 14_400 });
  const RED: NodeRedPluginAPI = {
    settings: {
      userDir: options.userDir,
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
    flowAdapter: options.adapter ?? createAdapter(),
    nodeTypesAdapter:
      options.nodeTypesAdapter ??
      createStaticNodeTypesAdapter(['inject', 'debug', 'template', 'function', 'comment'], {
        configs: { 'node-red/inject': SAMPLE_HTML, inject: SAMPLE_HTML },
      }),
    ...(options.catalogueFetcher ? { catalogueFetcher: options.catalogueFetcher } : {}),
  });
  return { app, linkStore };
}

async function mcpCallTool(
  app: Express,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request(app)
    .post('/mcp/rpc')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
  return { status: res.status, body: res.body as Record<string, unknown> };
}

function toolText(body: Record<string, unknown>): string {
  const result = body.result as
    { content?: { type: string; text: string }[]; isError?: boolean } | undefined;
  return result?.content?.[0]?.text ?? '';
}

describe('node-types helpers', () => {
  it('lists and filters by q', async () => {
    const adapter = createStaticNodeTypesAdapter(['inject', 'debug', 'template', 'mqtt in']);
    const all = await listNodeTypes(adapter);
    expect(all.types.map(t => t.type)).toEqual(
      expect.arrayContaining(['inject', 'debug', 'template', 'mqtt in'])
    );
    const filtered = await listNodeTypes(adapter, { q: 'inj' });
    expect(filtered.types.map(t => t.type)).toEqual(['inject']);
    expect(filtered.q).toBe('inj');
  });

  it('returns detail from HTML config and 404 when unknown', async () => {
    const adapter = createStaticNodeTypesAdapter(['inject', 'debug'], {
      configs: { inject: SAMPLE_HTML },
    });
    const detail = await getNodeTypeDetail(adapter, 'inject');
    expect(detail.type).toBe('inject');
    expect(detail.category).toBe('input');
    expect(detail.inputs).toBe(0);
    expect(detail.outputs).toBe(1);
    expect(detail.requiredConfigNodeTypes).toEqual(['mqtt-broker']);
    expect(detail.help).toEqual(
      expect.objectContaining({ summary: expect.stringMatching(/Inject a message/i) })
    );
    expect(detail).not.toHaveProperty('properties');
    expect(detail.defaults?.name).toEqual(expect.objectContaining({ value: '' }));

    const noHelp = await getNodeTypeDetail(adapter, 'inject', { includeHelp: false });
    expect(noHelp.help).toBeUndefined();

    await expect(getNodeTypeDetail(adapter, 'Debug')).rejects.toMatchObject({
      code: 'node_type_not_found',
      details: expect.objectContaining({ didYouMean: 'debug', caseSensitive: true }),
    });

    await expect(getNodeTypeDetail(adapter, 'nope-node')).rejects.toMatchObject({
      code: 'node_type_not_found',
      statusCode: 404,
    });
  });

  it('parses nested JS literal defaults to JSON (props/rules)', () => {
    const html = `
<script type="text/javascript">
  RED.nodes.registerType('inject',{
    category: 'common',
    defaults: {
      name: {value:""},
      props: {value:[{p:"payload"},{p:"topic",vt:"str"}]},
      rules: {value:[]}
    },
    inputs:0,
    outputs:1
  });
</script>`;
    const parsed = parseRegisterTypeFromHtml(html, 'inject');
    expect(parsed?.defaults?.props).toEqual(
      expect.objectContaining({
        value: [{ p: 'payload' }, { p: 'topic', vt: 'str' }],
      })
    );
    expect(parsed?.defaults?.rules).toEqual(expect.objectContaining({ value: [] }));
  });

  it('parseRegisterTypeFromHtml tolerates bad HTML', () => {
    expect(parseRegisterTypeFromHtml('<div>nope</div>')).toBeNull();
  });

  it('preserves JS escape sequences in default string values', () => {
    const html = `
<script type="text/javascript">
  RED.nodes.registerType('function',{
    category: 'function',
    defaults: {
      name: {value:'_DEFAULT_'},
      func: {value:"\\nreturn msg;"},
      path: {value:'C:\\\\temp\\\\file.txt'}
    },
    inputs:1,
    outputs:1
  });
</script>`;
    const parsed = parseRegisterTypeFromHtml(html, 'function');
    expect(parsed?.defaults?.func).toEqual(expect.objectContaining({ value: '\nreturn msg;' }));
    expect(parsed?.defaults?.name).toEqual(expect.objectContaining({ value: '' }));
    expect(parsed?.defaults?.path).toEqual(
      expect.objectContaining({ value: 'C:\\temp\\file.txt' })
    );
  });

  it('nearestNodeTypes ranks by edit distance, drops internals, and applies cutoff', () => {
    expect(nearestNodeTypes('injct', ['inject', 'debug', 'template', 'unknown'], 5)).toEqual([
      'inject',
    ]);
    expect(nearestNodeTypes('injct', ['inject', 'unknown'], 5)).not.toContain('unknown');
    // Weak/unrelated matches → empty list (not "nearest garbage").
    expect(nearestNodeTypes('zzzzzz', ['inject', 'debug', 'template'], 5)).toEqual([]);
  });

  it('nearestNodeTypes prefers junction over function for junktion', () => {
    const nearest = nearestNodeTypes('junktion', ['function', 'junction', 'inject', 'debug'], 5);
    expect(nearest[0]).toBe('junction');
    expect(nearest).toContain('function');
  });

  it('assertKnownNodeTypes throws unknown_node_type with nearest', async () => {
    const adapter = createStaticNodeTypesAdapter(['inject', 'debug', 'template']);
    try {
      await assertKnownNodeTypes(adapter, {
        id: 'tab-1',
        type: 'tab',
        nodes: [{ id: 'n1', type: 'injct', z: 'tab-1' }],
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AiOpsValidationError);
      const err = e as AiOpsValidationError;
      expect(err.code).toBe('unknown_node_type');
      expect(err.details?.type).toBe('injct');
      expect(err.details?.nearest).toEqual(expect.arrayContaining(['inject']));
    }
  });

  it('assertKnownNodeTypes rejects non-string node.type (object/number)', async () => {
    const adapter = createStaticNodeTypesAdapter(['inject', 'debug']);
    await expect(
      assertKnownNodeTypes(adapter, {
        id: 'tab-1',
        type: 'tab',
        nodes: [{ id: 'n1', type: { x: 1 }, z: 'tab-1' }],
      })
    ).rejects.toMatchObject({ code: 'invalid_node_type' });
    await expect(
      assertKnownNodeTypes(adapter, {
        id: 'tab-1',
        type: 'tab',
        nodes: [{ id: 'n2', type: 42, z: 'tab-1' }],
      })
    ).rejects.toMatchObject({ code: 'invalid_node_type' });
    await expect(
      assertKnownNodeTypes(adapter, {
        id: 'tab-1',
        type: 'tab',
        nodes: [{ id: 'n3', z: 'tab-1' }],
      })
    ).rejects.toMatchObject({ code: 'missing_node_type' });
  });

  it('paletteMatchScore ranks exact contrib/node suffix above keyword stacks', () => {
    const exact = paletteMatchScore('modbus', 'node-red-contrib-modbus', ['modbus'], 'modbus');
    const stacked = paletteMatchScore(
      'modbus',
      'node-red-contrib-industrial-modbus-kit-0',
      ['modbus', 'modbus-tcp', 'modbus-serial', 'modbus-rtu', 'plc'],
      'industrial modbus toolkit with modbus helpers'
    );
    expect(exact).toBe(10_000);
    expect(exact).toBeGreaterThan(stacked);
  });

  it('palette search marks installed and never installs', async () => {
    resetCatalogueCache();
    const adapter = createStaticNodeTypesAdapter(['inject'], { module: 'node-red' });
    const fetcher = mockCatalogueFetcher();
    const result = await searchPalette(adapter, 'foo', { catalogueFetcher: fetcher });
    expect(result.hint).toMatch(/Recommend only/i);
    expect(result.hint).toMatch(/never installs/i);
    expect(result.modules.some(m => m.module === 'node-red-contrib-foo')).toBe(true);
    const foo = result.modules.find(m => m.module === 'node-red-contrib-foo');
    expect(foo?.installed).toBe(false);
    expect(result.modules.some(m => m.module === 'node-red')).toBe(false);
    resetCatalogueCache();
    const coreHit = await searchPalette(adapter, 'core', { catalogueFetcher: fetcher });
    const nr = coreHit.modules.find(m => m.module === 'node-red');
    expect(nr?.installed).toBe(true);

    resetCatalogueCache();
    const modbus = await searchPalette(adapter, 'modbus', { catalogueFetcher: fetcher });
    expect(modbus.modules[0]?.module).toBe('node-red-contrib-modbus');
    expect(modbus.modules.map(m => m.module)).toContain('node-red-contrib-something-else');
    expect(modbus.modules[0]?.module).not.toBe('node-red-contrib-something-else');
    // Exact package suffix stays #1 even when decoys have far higher downloads.
    expect(modbus.modules.findIndex(m => m.module === 'node-red-contrib-modbus')).toBe(0);
  });
});

describe('node-types HTTP + MCP + docs', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-node-types-'));
    resetCatalogueCache();
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    resetCatalogueCache();
  });

  it('REST lists, details, 404, and palette search', async () => {
    const { app, linkStore } = createApp({
      userDir,
      catalogueFetcher: mockCatalogueFetcher(),
    });
    const link = linkStore.create({ kind: 'rest', label: 'nt' });
    const auth = { Authorization: `Bearer ${link.token}` };

    const list = await request(app).get('/mcp/api/v1/node-types?q=inj').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.types.map((t: { type: string }) => t.type)).toEqual(['inject']);

    const detail = await request(app).get('/mcp/api/v1/node-types/inject').set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.category).toBe('input');

    const missing = await request(app).get('/mcp/api/v1/node-types/nope').set(auth);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('node_type_not_found');

    const palette = await request(app).get('/mcp/api/v1/palette/search?q=foo').set(auth);
    expect(palette.status).toBe(200);
    expect(palette.body.hint).toMatch(/never installs/i);
    expect(palette.body.modules[0].module).toBe('node-red-contrib-foo');
    expect(palette.body.modules[0].installed).toBe(false);
  });

  it('GET-link exposes node-types and palette search', async () => {
    const { app, linkStore } = createApp({
      userDir,
      catalogueFetcher: mockCatalogueFetcher(),
    });
    const link = linkStore.create({ label: 'gl' });
    const base = `/mcp/a/${link.token}`;

    const list = await request(app).get(`${base}/node-types?q=debug`);
    expect(list.status).toBe(200);
    expect(list.body.types[0].type).toBe('debug');

    const palette = await request(app).get(`${base}/palette/search?q=foo`);
    expect(palette.status).toBe(200);
    expect(palette.body.hint).toMatch(/Manage palette/i);
  });

  it('submit_proposal rejects unknown_node_type with nearest', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ kind: 'rest', label: 'bad' });
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
            nodes: [{ id: 'n9', type: 'totally-fake-node', z: 'tab-1', wires: [[]] }],
          },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_node_type');
    expect(res.body.type).toBe('totally-fake-node');
    expect(Array.isArray(res.body.nearest)).toBe(true);
  });

  it('replace_flow rejects object node.type on REST, MCP, and GET', async () => {
    const { app, linkStore } = createApp({ userDir });
    const badFlow = {
      id: 'tab-1',
      type: 'tab',
      nodes: [{ id: 'n9', type: { x: 1 }, z: 'tab-1', wires: [[]] }],
    };

    const restLink = linkStore.create({ kind: 'rest', label: 'obj-rest' });
    const rest = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${restLink.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: { flowId: 'tab-1', flow: badFlow },
      });
    expect(rest.status).toBe(400);
    expect(rest.body.code).toBe('invalid_node_type');

    const mcpLink = linkStore.create({ kind: 'mcp', label: 'obj-mcp' });
    const mcp = await mcpCallTool(app, mcpLink.token, 'submit_proposal', {
      type: 'replace_flow',
      expectedRev: 'rev-1',
      payload: { flowId: 'tab-1', flow: badFlow },
    });
    expect(mcp.status).toBe(200);
    expect(mcp.body.result).toMatchObject({ isError: true });
    const mcpText =
      (
        (mcp.body.result as { content?: { type: string; text: string }[] } | undefined)?.content ??
        []
      ).find(c => c.type === 'text')?.text ?? '';
    expect(mcpText).toMatch(/invalid_node_type|must be a string|node\.type/i);

    const getLink = linkStore.create({ kind: 'get_link', label: 'obj-get' });
    const patch = Buffer.from(
      JSON.stringify({ type: 'replace_flow', flowId: 'tab-1', flow: badFlow }),
      'utf8'
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const getRes = await request(app).get(
      `/mcp/a/${getLink.token}/propose?flow=tab-1&rev=rev-1&patch=${patch}`
    );
    expect(getRes.status).toBe(400);
    expect(getRes.body.code).toBe('invalid_node_type');
  });

  it('MCP tools list_node_types / get_node_type / search_palette are listed and callable', async () => {
    const { app, linkStore } = createApp({
      userDir,
      catalogueFetcher: mockCatalogueFetcher(),
    });
    const link = linkStore.create({ kind: 'mcp', label: 'mcp' });

    const listed = await request(app)
      .post('/mcp/rpc')
      .set('Authorization', `Bearer ${link.token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(listed.status).toBe(200);
    const names = ((listed.body.result as { tools: { name: string }[] }).tools ?? []).map(
      t => t.name
    );
    expect(names).toEqual(
      expect.arrayContaining(['list_node_types', 'get_node_type', 'search_palette'])
    );

    const listCall = await mcpCallTool(app, link.token, 'list_node_types', { q: 'inj' });
    expect(listCall.status).toBe(200);
    const listPayload = JSON.parse(toolText(listCall.body)) as {
      types: { type: string }[];
    };
    expect(listPayload.types.map(t => t.type)).toEqual(['inject']);

    const getCall = await mcpCallTool(app, link.token, 'get_node_type', { type: 'inject' });
    expect(JSON.parse(toolText(getCall.body)).type).toBe('inject');

    const searchCall = await mcpCallTool(app, link.token, 'search_palette', { q: 'foo' });
    const searchPayload = JSON.parse(toolText(searchCall.body)) as {
      hint: string;
      modules: { module: string }[];
    };
    expect(searchPayload.hint).toMatch(/never installs/i);
    expect(searchPayload.modules[0]?.module).toBe('node-red-contrib-foo');
  });

  it('docs put Also available near top with MCP snippets and palette guidance', () => {
    const md = renderGetLinkDocs({
      link: {
        id: 'lnk-1',
        kind: 'access-link',
        expiresAt: '2099-01-01T00:00:00.000Z',
        label: 'demo',
      },
      openapiPath: '/mcp/api/v1/openapi.yaml',
      restApiBase: '/mcp/api/v1',
      mcpRpcPath: '/mcp/rpc',
    });
    const alsoIdx = md.indexOf('## Also available');
    const workflowIdx = md.indexOf('## Step-by-step workflow');
    expect(alsoIdx).toBeGreaterThan(0);
    expect(alsoIdx).toBeLessThan(workflowIdx);
    expect(md).toMatch(/Which channel to use/i);
    expect(md).toMatch(/Prefer MCP or REST/i);
    expect(md).toMatch(/get_link/);
    expect(md).toMatch(/help=0|Core.*catalogue|case-sensitive/i);
    expect(md).toMatch(/rest.*token|rest-token/i);
    expect(md).toMatch(/mcp.*token|mcp-token/i);
    expect(md).toMatch(/not this path token/i);
    expect(md).toMatch(/self-contained GET link \(get_link\)/i);
    expect(md).toMatch(/claude_desktop_config\.json/);
    expect(md).toMatch(/mcp\.json/);
    expect(md).toMatch(/https:\/\/YOUR-NODE-RED\/mcp\/rpc/);
    expect(md).toMatch(/Bearer aia_/);
    expect(md).toMatch(/\.\/node-types\?q=/);
    expect(md).toMatch(/\.\/palette\/search\?q=/);
    expect(md).toMatch(/unknown_node_type/);
    expect(md).toMatch(/Manage palette/);
    expect(md).toMatch(/never installs/i);
    expect(md).not.toMatch(/http:\/\/127\.0\.0\.1/);
  });

  it('discovery index lists node-types and palette endpoints', async () => {
    const { app } = createApp({ userDir });
    const res = await request(app).get('/mcp/api/v1');
    expect(res.status).toBe(200);
    const paths = (res.body.endpoints as { path: string }[]).map(e => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(['/node-types', '/node-types/{type}', '/palette/search'])
    );
  });
});
