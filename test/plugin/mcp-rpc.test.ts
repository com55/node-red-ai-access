/**
 * MCP Streamable HTTP endpoint `/mcp/rpc` — auth, tools, REST parity.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import {
  ACCESS_LINK_INVALID_CODE,
  ACCESS_LINK_INVALID_MESSAGE,
  ACCESS_LINK_MISSING_CODE,
  ACCESS_LINK_MISSING_MESSAGE,
  ACCESS_LINK_WWW_AUTHENTICATE,
} from '../../src/plugin/access-link-auth.js';
import { registerRoutes } from '../../src/plugin/index.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter } from '../../src/runtime/types.js';

const MCP_ACCEPT = 'application/json, text/event-stream';

function createApp(options: {
  userDir: string;
  adapter?: FlowAdapter;
  /** When true, omit adminAuth (AI features off unless allowWithoutAdminAuth). */
  omitAdminAuth?: boolean;
  adminAuth?: Record<string, unknown>;
  aiAccess?: Record<string, unknown>;
}): {
  app: Express;
  linkStore: AccessLinkStore;
} {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const linkStore = new AccessLinkStore({ maxActiveLinks: 10 });

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir: options.userDir,
      httpAdminRoot: '/',
      ...(options.omitAdminAuth ? {} : { adminAuth: options.adminAuth ?? { type: 'credentials' } }),
      aiAccess: {
        defaultDeploymentType: 'nodes',
        ...(options.aiAccess ?? {}),
      },
    },
    httpAdmin: app,
    auth: {
      needsPermission() {
        return (_req: Request, _res: Response, next: NextFunction) => next();
      },
    },
    plugins: {
      registerPlugin() {
        // unused
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  const adapter: FlowAdapter =
    options.adapter ??
    ({
      kind: 'red',
      getFlows: () =>
        Promise.resolve({
          rev: 'rev-1',
          flows: [
            { id: 'tab-1', type: 'tab', label: 'Main' },
            { id: 'n1', type: 'inject', z: 'tab-1' },
          ],
        }),
      getFlow: (id: string) =>
        Promise.resolve({
          rev: 'rev-1',
          flow: {
            id,
            type: 'tab',
            label: 'Main',
            nodes: [{ id: 'n1', type: 'inject', z: id }],
            configs: [],
          },
        }),
      updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
    } as FlowAdapter);

  registerRoutes(RED, { linkStore, flowAdapter: adapter });
  return { app, linkStore };
}

async function mcpRpc(
  app: Express,
  token: string | null,
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = request(app)
    .post('/mcp/rpc')
    .set('Accept', MCP_ACCEPT)
    .set('Content-Type', 'application/json');
  if (token) {
    req.set('Authorization', `Bearer ${token}`);
  }
  const res = await req.send(body);
  return { status: res.status, body: res.body as Record<string, unknown> };
}

async function callTool(
  app: Express,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ status: number; result?: Record<string, unknown>; error?: unknown }> {
  const res = await mcpRpc(app, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return {
    status: res.status,
    result: res.body.result as Record<string, unknown> | undefined,
    error: res.body.error,
  };
}

function parseToolJson(result: Record<string, unknown> | undefined): unknown {
  const content = result?.content as { type: string; text: string }[] | undefined;
  expect(content?.[0]?.type).toBe('text');
  return JSON.parse(content![0]!.text) as unknown;
}

describe('MCP /mcp/rpc Streamable HTTP', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-mcp-rpc-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('rejects missing/invalid/revoked Bearer with ask-for-new-link message', async () => {
    const { app, linkStore } = createApp({ userDir });

    const missing = await mcpRpc(app, null, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    });
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe(ACCESS_LINK_MISSING_MESSAGE);
    expect(missing.body.code).toBe(ACCESS_LINK_MISSING_CODE);
    expect(
      (
        await request(app)
          .post('/mcp/rpc')
          .set('Accept', MCP_ACCEPT)
          .set('Content-Type', 'application/json')
          .send({})
      ).headers['www-authenticate']
    ).toBe(ACCESS_LINK_WWW_AUTHENTICATE);

    const bad = await mcpRpc(app, 'not-a-token', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe(ACCESS_LINK_INVALID_MESSAGE);
    expect(bad.body.code).toBe(ACCESS_LINK_INVALID_CODE);

    const created = linkStore.create({ label: 'tmp' });
    linkStore.revoke(created.id);
    const revoked = await mcpRpc(app, created.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(revoked.status).toBe(401);
    expect(revoked.body.error).toBe(ACCESS_LINK_INVALID_MESSAGE);
  });

  it('returns 403 when AI features are disabled (adminAuth off, no opt-in)', async () => {
    const { app, linkStore } = createApp({
      userDir,
      omitAdminAuth: true,
      aiAccess: { allowWithoutAdminAuth: false },
    });
    // Link store still works in-memory; middleware checks AI features first.
    const link = linkStore.create({ label: 'x' });
    const res = await mcpRpc(app, link.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/AI Access features are disabled/);
  });

  it('allows access when allowWithoutAdminAuth is true', async () => {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    const linkStore = new AccessLinkStore({ maxActiveLinks: 10 });
    const RED: NodeRedPluginAPI = {
      settings: {
        userDir,
        httpAdminRoot: '/',
        aiAccess: { allowWithoutAdminAuth: true },
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
      log: { info: vi.fn() },
    };
    registerRoutes(RED, {
      linkStore,
      flowAdapter: {
        kind: 'red',
        getFlows: () => Promise.resolve({ rev: 'r', flows: [] }),
        getFlow: () => Promise.resolve({ rev: 'r', flow: { id: 't', type: 'tab' } }),
        updateFlow: () => Promise.resolve({ rev: 'r2' }),
      },
    });
    const link = linkStore.create({ label: 'local' });
    const res = await mcpRpc(app, link.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(res.status).toBe(200);
    const tools = (res.body.result as { tools: { name: string }[] }).tools.map(t => t.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        'get_status',
        'list_flows',
        'get_flow',
        'submit_proposal',
        'list_my_proposals',
        'get_proposal',
      ])
    );
    expect(tools).not.toEqual(expect.arrayContaining(['approve_proposal', 'reject_proposal']));
    expect(tools).not.toContain('create_link');
  });

  it('lists only AI tools (no approve/reject/link)', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'claude' });
    const res = await mcpRpc(app, link.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(res.status).toBe(200);
    const names = (res.body.result as { tools: { name: string }[] }).tools.map(t => t.name);
    expect(names.sort()).toEqual(
      [
        'get_flow',
        'get_proposal',
        'get_status',
        'list_flows',
        'list_my_proposals',
        'submit_proposal',
      ].sort()
    );
    const tools = (res.body.result as { tools: { name: string; description?: string }[] }).tools;
    const submit = tools.find(t => t.name === 'submit_proposal');
    expect(submit?.description).toMatch(/expectedRev/);
    expect(submit?.description).toMatch(/nodes\[\]/);
    expect(submit?.description).toMatch(/413/);
    expect(submit?.description).toMatch(/get_flow|list_flows/);
    const getStatus = tools.find(t => t.name === 'get_status');
    expect(getStatus?.description).toMatch(/permission is null|permission.*null/i);
  });

  it('get_status / list_flows / get_flow / submit / list / get_proposal work', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'bot' });

    const status = await callTool(app, link.token, 'get_status');
    expect(status.status).toBe(200);
    expect(status.result?.isError).toBeFalsy();
    const statusJson = parseToolJson(status.result) as {
      ok: boolean;
      aiFeaturesEnabled: boolean;
      permission: string | null;
      caller?: { kind: string; linkId?: string };
    };
    expect(statusJson.ok).toBe(true);
    expect(statusJson.aiFeaturesEnabled).toBe(true);
    expect(statusJson.permission).toBeNull();
    expect(statusJson.caller).toMatchObject({ kind: 'access-link', linkId: link.id });

    const flows = await callTool(app, link.token, 'list_flows');
    expect(flows.status).toBe(200);
    const flowsJson = parseToolJson(flows.result) as { rev: string; flows: unknown[] };
    expect(flowsJson.rev).toBe('rev-1');
    expect(Array.isArray(flowsJson.flows)).toBe(true);

    const one = await callTool(app, link.token, 'get_flow', { id: 'tab-1' });
    expect(one.status).toBe(200);
    const oneJson = parseToolJson(one.result) as { rev: string; flow: { id: string } };
    expect(oneJson.flow.id).toBe('tab-1');

    const submitted = await callTool(app, link.token, 'submit_proposal', {
      type: 'replace_flow',
      expected_rev: flowsJson.rev,
      payload: {
        flowId: 'tab-1',
        flow: {
          id: 'tab-1',
          type: 'tab',
          label: 'Main',
          nodes: [{ id: 'n1', type: 'inject', z: 'tab-1' }],
        },
      },
    });
    expect(submitted.status).toBe(200);
    expect(submitted.result?.isError).toBeFalsy();
    const proposal = parseToolJson(submitted.result) as {
      id: string;
      status: string;
      expectedRev: string;
      createdBy: { linkId: string };
    };
    expect(proposal.status).toBe('pending');
    expect(proposal.expectedRev).toBe('rev-1');
    expect(proposal.createdBy.linkId).toBe(link.id);

    const mine = await callTool(app, link.token, 'list_my_proposals');
    const mineJson = parseToolJson(mine.result) as { proposals: { id: string }[] };
    expect(mineJson.proposals).toHaveLength(1);
    expect(mineJson.proposals[0]!.id).toBe(proposal.id);

    const got = await callTool(app, link.token, 'get_proposal', { id: proposal.id });
    const gotJson = parseToolJson(got.result) as { id: string };
    expect(gotJson.id).toBe(proposal.id);
  });

  it('parity: MCP submit_proposal matches REST POST /proposals', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'parity' });
    const auth = { Authorization: `Bearer ${link.token}` };
    const body = {
      type: 'replace_flow' as const,
      expectedRev: 'rev-1',
      payload: {
        flowId: 'tab-1',
        flow: {
          id: 'tab-1',
          type: 'tab',
          label: 'Main',
          nodes: [{ id: 'n1', type: 'inject', z: 'tab-1' }],
        },
      },
    };

    const rest = await request(app).post('/mcp/api/v1/proposals').set(auth).send(body);
    expect(rest.status).toBe(201);

    const mcp = await callTool(app, link.token, 'submit_proposal', body);
    expect(mcp.status).toBe(200);
    expect(mcp.result?.isError).toBeFalsy();
    const mcpProposal = parseToolJson(mcp.result) as {
      type: string;
      status: string;
      expectedRev: string;
      payload: { flowId: string };
      createdBy: { kind: string; linkId: string };
    };

    expect(mcpProposal).toMatchObject({
      type: rest.body.type,
      status: rest.body.status,
      expectedRev: rest.body.expectedRev,
      payload: { flowId: rest.body.payload.flowId },
      createdBy: { kind: 'access-link', linkId: link.id },
    });

    const restList = await request(app).get('/mcp/api/v1/proposals').set(auth);
    const mcpList = await callTool(app, link.token, 'list_my_proposals');
    const mcpListJson = parseToolJson(mcpList.result) as { proposals: unknown[] };
    expect(mcpListJson.proposals).toHaveLength(restList.body.proposals.length);

    const restFlows = await request(app).get('/mcp/api/v1/flows').set(auth);
    const mcpFlows = await callTool(app, link.token, 'list_flows');
    expect(parseToolJson(mcpFlows.result)).toEqual(restFlows.body);
  });

  it('returns 405 for GET /mcp/rpc', async () => {
    const { app, linkStore } = createApp({ userDir });
    const link = linkStore.create({ label: 'g' });
    const res = await request(app)
      .get('/mcp/rpc')
      .set('Authorization', `Bearer ${link.token}`)
      .set('Accept', MCP_ACCEPT);
    expect(res.status).toBe(405);
  });
});
