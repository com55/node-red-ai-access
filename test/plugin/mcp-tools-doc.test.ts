/**
 * Keeps docs/mcp-tools.md in sync with live MCP tools/list schemas.
 * Set UPDATE_MCP_TOOLS=1 to rewrite the doc file.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import { formatMcpToolsMarkdown, type McpToolListItem } from '../../src/plugin/mcp-tools-doc.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DOC_PATH = join(ROOT, 'docs/mcp-tools.md');
const MCP_ACCEPT = 'application/json, text/event-stream';

function createApp(userDir: string): { app: Express; linkStore: AccessLinkStore } {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 5 });
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
        // unused
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
  return { app, linkStore };
}

async function liveToolsMarkdown(app: Express, token: string): Promise<string> {
  const res = await request(app)
    .post('/mcp/rpc')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', MCP_ACCEPT)
    .set('Content-Type', 'application/json')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(res.status).toBe(200);
  const tools = (res.body.result as { tools: McpToolListItem[] }).tools;
  expect(tools.length).toBeGreaterThan(5);
  return formatMcpToolsMarkdown(tools);
}

describe('docs/mcp-tools.md', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-mcp-doc-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('matches live tools/list (or updates when UPDATE_MCP_TOOLS=1)', async () => {
    const { app, linkStore } = createApp(userDir);
    const link = linkStore.create({ kind: 'mcp', label: 'doc' });
    const generated = await liveToolsMarkdown(app, link.token);

    if (process.env.UPDATE_MCP_TOOLS === '1') {
      writeFileSync(DOC_PATH, generated, 'utf8');
    }

    const onDisk = readFileSync(DOC_PATH, 'utf8');
    expect(onDisk).toBe(generated);
  });

  it('formatMcpToolsMarkdown sorts tools and lists parameters', () => {
    const md = formatMcpToolsMarkdown([
      {
        name: 'zeta',
        description: 'Z tool',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'alpha',
        description: 'A tool',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Flow id' },
          },
          required: ['id'],
        },
      },
    ]);
    expect(md).toMatch(/## `alpha`/);
    expect(md.indexOf('## `alpha`')).toBeLessThan(md.indexOf('## `zeta`'));
    expect(md).toMatch(/\| `id` \| yes \| string \| Flow id \|/);
  });
});
