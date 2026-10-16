/**
 * Channel onboarding: REST prompt must include the custom-headers → GET-link
 * line; MCP setup tabs and docs index are present.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const REST_CUSTOM_HEADERS_LINE =
  'If you cannot send HTTP requests with custom headers (e.g. a web chat app), stop and ask the user to create a GET link instead; do not retry.';

function createApp(userDir: string): Express {
  const app = express();
  app.use(express.json());
  const store = new AccessLinkStore({ maxActiveLinks: 10 });
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
  registerRoutes(RED, { linkStore: store });
  return app;
}

describe('channel onboarding copy', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-onboard-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('/mcp REST prompt includes base URL, Bearer, OpenAPI, guide, and custom-headers line', async () => {
    const app = createApp(userDir);
    const page = await request(app).get('/mcp');
    expect(page.status).toBe(200);
    expect(page.text).toContain(REST_CUSTOM_HEADERS_LINE);
    expect(page.text).toMatch(/restPromptForAi/);
    expect(page.text).toMatch(/Base URL: /);
    expect(page.text).toMatch(/OpenAPI: /);
    expect(page.text).toMatch(/Discovery guide: /);
    expect(page.text).toMatch(/human owner must approve/i);
    expect(page.text).toMatch(/Copy REST prompt for AI/);
  });

  it('/mcp MCP setup panel has client tabs with distinct copy labels', async () => {
    const app = createApp(userDir);
    const page = await request(app).get('/mcp');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/id="mcp-setup-panel"/);
    expect(page.text).toMatch(/mcpSetupSnippets/);
    expect(page.text).toMatch(/Copy Claude Desktop JSON/);
    expect(page.text).toMatch(/Copy Cursor mcp\.json/);
    expect(page.text).toMatch(/Copy VS Code MCP JSON/);
    expect(page.text).toMatch(/Copy Claude Code CLI command/);
    expect(page.text).toMatch(/Copy Streamable HTTP details/);
    expect(page.text).toMatch(
      /If your AI app cannot add MCP servers, create a REST or GET link instead/
    );
  });

  it('docs index and channel docs exist with expected anchors', () => {
    const index = readFileSync(join(ROOT, 'docs/README.md'), 'utf8');
    expect(index).toMatch(/mcp-clients\.md/);
    expect(index).toMatch(/errors\.md/);
    expect(index).toMatch(/mcp-tools\.md/);
    expect(index).toMatch(/openapi\.yaml/);

    const clients = readFileSync(join(ROOT, 'docs/mcp-clients.md'), 'utf8');
    expect(clients).toMatch(/Claude Desktop/);
    expect(clients).toMatch(/Cursor/);
    expect(clients).toMatch(/VS Code/);
    expect(clients).toMatch(/Claude Code CLI/);
    expect(clients).toMatch(/Streamable HTTP/);

    const errors = readFileSync(join(ROOT, 'docs/errors.md'), 'utf8');
    expect(errors).toMatch(/token_expired/);
    expect(errors).toMatch(/wrong_token_kind/);
    expect(errors).toMatch(/\|\s*Channels\s*\|/);
  });
});
