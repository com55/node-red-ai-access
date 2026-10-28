/**
 * /mcp admin page — public boot shell + API auth via editor localStorage Bearer.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { registerRoutes } from '../../src/plugin/index.js';
import type { AiAccessSettings, NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter } from '../../src/runtime/types.js';

interface MockUser {
  username: string;
  permissions: string | string[];
}

function createApp(options: {
  userDir: string;
  adminAuth?: unknown;
  aiAccess?: AiAccessSettings;
  httpAdminRoot?: string;
  authenticate?: (req: Request, _res: Response, next: NextFunction) => void;
}): { app: Express; linkStore: AccessLinkStore } {
  const app = express();
  app.use(express.json());

  const authenticate =
    options.authenticate ??
    ((_req: Request, _res: Response, next: NextFunction) => {
      next();
    });

  const linkStore = new AccessLinkStore({ maxActiveLinks: 10 });

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir: options.userDir,
      httpAdminRoot: options.httpAdminRoot ?? '/',
      ...(options.adminAuth !== undefined ? { adminAuth: options.adminAuth } : {}),
      ...(options.aiAccess !== undefined ? { aiAccess: options.aiAccess } : {}),
    },
    httpAdmin: app,
    auth: {
      needsPermission(permission: string) {
        return (req: Request, res: Response, next: NextFunction) => {
          authenticate(req, res, (err?: unknown) => {
            if (err) {
              next(err as Error);
              return;
            }
            const user = (req as Request & { user?: MockUser }).user;
            if (!user) {
              res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
              return;
            }
            const scopes = Array.isArray(user.permissions) ? user.permissions : [user.permissions];
            const allowed =
              scopes.includes('*') ||
              scopes.includes(permission) ||
              (permission === 'read' && scopes.includes('read'));
            if (!allowed) {
              res.status(401).end();
              return;
            }
            next();
          });
        };
      },
    },
    plugins: {
      registerPlugin() {
        // unused — registerRoutes called directly
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  const adapter: FlowAdapter = {
    kind: 'red',
    getFlows: () =>
      Promise.resolve({ rev: 'rev-1', flows: [{ id: 'tab-1', type: 'tab', label: 'Main' }] }),
    getFlow: () =>
      Promise.resolve({
        rev: 'rev-1',
        flow: { id: 'tab-1', type: 'tab', label: 'Main', nodes: [] },
      }),
    updateFlow: () => Promise.resolve({ rev: 'rev-2' }),
  };

  registerRoutes(RED, { linkStore, flowAdapter: adapter });
  return { app, linkStore };
}

function asUser(permissions: string | string[], username = 'user') {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: MockUser }).user = { username, permissions };
    next();
  };
}

describe('/mcp admin page', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-page-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('serves GET /mcp without server-side auth (client reads editor localStorage)', async () => {
    const { app } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
      httpAdminRoot: '/editor',
    });

    const res = await request(app).get('/ai-access');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers.pragma).toMatch(/no-cache/i);
    expect(res.text).toMatch(/http-equiv="Cache-Control"[^>]*no-store/);
    expect(res.text).toMatch(/alignSplitDiffLines/);
    expect(res.text).toMatch(/history\.replaceState/);
    expect(res.text).toMatch(/replaceLocationHash\('#proposals'\)/);
    expect(res.text).toMatch(/initialTabFromHash/);
    expect(res.text).toMatch(/Intl\.DateTimeFormat/);
    expect(res.text).toMatch(/titleFromDisplayName/);
    expect(res.text).toMatch(/Never render API displayName/);
    expect(res.text).toMatch(/data-config=/);
    expect(res.text).toMatch(/editorRoot/);
    expect(res.text).toMatch(/auth-tokens-editor/);
    expect(res.text).toMatch(/localStorage/);
    expect(res.text).toMatch(/id="section-status"/);
    expect(res.text).toMatch(/id="section-links"/);
    expect(res.text).toMatch(/id="section-proposals"/);
    expect(res.text).toMatch(/id="section-logs"/);
    expect(res.text).toMatch(/id="logs-filter"/);
    expect(res.text).toMatch(/auditSummary|audit-summary|fmtCompact/);
    expect(res.text).toMatch(/proposals\/.*\/diff|loadProposalDiff/);
    expect(res.text).toMatch(/accessLinkCopyText|Copy link for AI|token-copy-btn/);
    expect(res.text).toMatch(/mcpRpc|openapi\.yaml|Self-contained GET link|mcp\/a\//);
    // Phase 2B — token kind channel select + kind-aware copy labels.
    expect(res.text).toMatch(/id="link-kind"|Token channel/);
    expect(res.text).toMatch(/GET link \(chat paste\)/);
    expect(res.text).toMatch(/REST Bearer/);
    expect(res.text).toMatch(/MCP token/);
    // Token expiry dropdown + get_link >24h reset note.
    expect(res.text).toMatch(/id="link-ttl-preset"/);
    expect(res.text).toMatch(/15 minutes/);
    expect(res.text).toMatch(/7 days/);
    expect(res.text).toMatch(/id="link-ttl-custom-row"|Custom/);
    expect(res.text).toMatch(/TTL_MAX_GET_LINK|Expiry reset to 1 hour/);
    expect(res.text).toMatch(/id="link-ttl-reset-note"|ttl-reset-note/);
    expect(res.text).toMatch(/id="link-ttl-warn"|Long-lived tokens stay usable longer/);
    expect(res.text).toMatch(/linkCopyMaterial|normalizeLinkKind|kindBadgeHtml/);
    expect(res.text).toMatch(/Copy REST prompt for AI|restPromptForAi/);
    expect(res.text).toMatch(
      /If you cannot send HTTP requests with custom headers \(e\.g\. a web chat app\), stop and ask the user to create a GET link instead; do not retry\./
    );
    expect(res.text).toMatch(/mcp-setup-panel|renderMcpSetupPanel|mcpSetupSnippets/);
    // Generic per-channel usage (placeholder token) that follows the Channel select.
    expect(res.text).toMatch(/id="token-usage"/);
    expect(res.text).toMatch(/kindSel\.addEventListener\('change', renderTokenUsage\)/);
    expect(res.text).toMatch(/var TOKEN_PLACEHOLDER = '<YOUR_TOKEN>'/);
    // Real token only in a one-time modal that is emptied on close.
    expect(res.text).toMatch(/This is the only time the token is shown\./);
    expect(res.text).toMatch(/aria-labelledby', 'token-modal-title'/);
    expect(res.text).toMatch(/function cleanup\(\) \{[\s\S]*?dialog\.innerHTML = '';/);
    expect(res.text).toMatch(/dialog\.addEventListener\('close', cleanup\)/);
    // Fallback without native showModal: Esc and form submit still clear the token.
    expect(res.text).toMatch(/document\.addEventListener\('keydown', onKey, true\)/);
    expect(res.text).toMatch(/e\.preventDefault\(\);\s*closeTokenModal\(\);/);
    // Labels are escaped in the links table.
    expect(res.text).toMatch(/esc\(l\.label \|\| '—'\)/);
    expect(res.text).toMatch(/esc\(label \|\| 'Access token created'\)/);
    // The links table no longer offers copying existing tokens.
    expect(res.text).not.toMatch(/class="action secondary copy-link"/);
    expect(res.text).toMatch(
      /Copy Claude Desktop JSON|Copy Cursor mcp\.json|Copy VS Code MCP JSON/
    );
    expect(res.text).toMatch(/If your AI app cannot add MCP servers/);
    expect(res.text).toMatch(/Copy GET link for AI chat/);
    expect(res.text).toMatch(/kind-badge|data-kind/);
    expect(res.text).toMatch(/wrong_token_kind|separate tokens/);
    expect(res.text).toMatch(/max-width:\s*min\(1400px,\s*95vw\)/);
    expect(res.text).toMatch(/Side by side|data-diff-mode/);
    expect(res.text).toMatch(/diff-split|diff-line/);
    expect(res.text).toMatch(/Node added|Node removed/);
    expect(res.text).toMatch(/base snapshot|vsCurrent/);
    expect(res.text).toMatch(/to review|out of date/);
    expect(res.text).toMatch(/Dismiss all out-of-date/);
    expect(res.text).toMatch(/Deploy options/);
    expect(res.text).toMatch(/filter-decided-count/);
    expect(res.text).toMatch(/for troubleshooting/);
    expect(res.text).toMatch(/You're an admin/);
    // Diagnostics "Your role" row — never a "full access" chip (sounds like AI scope).
    // a90b73c landed in #50 squash (b961271); stale dist/plugin.cjs was the
    // real-world cause of the chip resurfacing after hard refresh — assert HTML.
    expect(res.text).not.toMatch(/['"]full access['"]|full-access/i);
    expect(res.text).not.toMatch(/id="status-badge"/);
    expect(res.text).not.toMatch(/modeLabel = s\.permission === '\*' \? 'full access'/);
    expect(res.text).toMatch(/id="status-role"/);
    expect(res.text).toMatch(/Your role/);
    expect(res.text).toMatch(/Admin \(can approve & manage links\)/);
    expect(res.text).toMatch(/'Read-only'/);
    expect(res.text).toMatch(/This is your Node-RED permission/);
    expect(res.text).toMatch(/AI access links can only read/);
    expect(res.text).toMatch(/titleWasDisambiguated|time-exact|buildDisambiguatedTitles/);
    expect(res.text).toMatch(/renderHumanDiff|proposal-changes/);
    expect(res.text).toMatch(/dismiss-vs-reject/);
    expect(res.text).toMatch(/Out of date \(/);
    expect(res.text).toMatch(/renderStaleGroup|stale-group/);
    expect(res.text).toMatch(/Requested via link/);
    expect(res.text).toMatch(/Dismiss closes/);
    expect(res.text).toMatch(/Show .*line change|large-diff-btn/);
    expect(res.text).toMatch(/Editor changes since submission/);
    expect(res.text).toMatch(/Changes approval will deploy/);
    expect(res.text).toMatch(/mergedHash/);
    // Proposal id chip (first 8 hex after prop-) + search matches short/full id.
    expect(res.text).toMatch(/id="proposals-search"/);
    expect(res.text).toMatch(/proposalIdChip|proposalShortId|data-copy-id/);
    expect(res.text).toMatch(/proposalMatchesSearch/);
    expect(res.text).toMatch(/first 8 hex|prop-/);
    expect(res.text).toMatch(/idCompact|any substring|full id|short id/);
    expect(res.text).toMatch(/cross-tab-hint|Switch to Decided|Switch to Pending/);
    expect(res.text).toMatch(/Copied proposal id/);
    expect(res.text).toMatch(/efd159aa/);
    expect(res.text).toMatch(/focusProposalFromHash/);
    expect(res.text).toMatch(/replaceLocationHash\('#proposals'\)/);
    // Reject modal shows proposal title; destructive approve uses confirm + summary.
    expect(res.text).toMatch(/reject-dialog-title/);
    expect(res.text).toMatch(/delete-confirm-dialog/);
    expect(res.text).toMatch(/delete-confirm-proposal-title|delete-confirm-summary/);
    expect(res.text).toMatch(/isLargeDelete/);
    expect(res.text).toMatch(/needsApproveConfirm/);
    expect(res.text).toMatch(/openDeleteConfirmDialog/);
    expect(res.text).toMatch(/deleteInput\.value !== 'DELETE'/);
    expect(res.text).toMatch(/diff\.baseRevStale/);
    expect(res.text).toMatch(/Type DELETE to confirm/);
    expect(res.text).toMatch(/formatDiffActionSummary|Summary:/);
    expect(res.text).toMatch(/toast-title|toast-link|View/);
    expect(res.text).toMatch(/settleSearchAfterAction|Cleared search/);
    expect(res.text).toMatch(
      /other proposal(?:s)? are now out of date|notifySidebarPendingRefresh/
    );
    // In-page confirm modal (revoke / dismiss) — no native window.confirm fallback.
    expect(res.text).toMatch(/id="confirm-dialog"/);
    expect(res.text).toMatch(/openConfirmDialog/);
    expect(res.text).toMatch(/trapDialogFocus|showInPageDialog/);
    expect(res.text).toMatch(/Revoke access link/);
    expect(res.text).toMatch(/Dismiss out-of-date proposals/);
    expect(res.text).not.toMatch(/window\.confirm|window\.alert|window\.prompt/);
    // Regression: Deletes X of Y banner must show for large deletes even when stale.
    expect(res.text).toMatch(/renderDeleteBanner|Deletes .* of .* nodes/);
    expect(res.text).not.toMatch(/isLargeDelete\([^)]+\) && !/);
  });

  it('keeps /mcp/api/v1/status behind admin auth', async () => {
    const { app } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
    });

    const unauth = await request(app).get('/mcp/api/v1/status');
    expect(unauth.status).toBe(401);

    const { app: app2 } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
      authenticate: asUser('*', 'admin'),
    });
    const auth = await request(app2).get('/mcp/api/v1/status');
    expect(auth.status).toBe(200);
    expect(auth.body.caller).toMatchObject({ kind: 'admin', permission: '*' });
  });

  it('exposes defaults on status for the page client', async () => {
    const { app } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
      aiAccess: {
        defaultLinkTtlSeconds: 3600,
        maxActiveLinks: 5,
        defaultDeploymentType: 'flows',
      },
      authenticate: asUser('*', 'admin'),
    });

    const status = await request(app).get('/mcp/api/v1/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      defaultLinkTtlSeconds: 3600,
      maxActiveLinks: 5,
      defaultDeploymentType: 'flows',
      caller: { kind: 'admin', permission: '*' },
    });
  });

  it('embeds client script that shows auth gate when editor token is missing', async () => {
    const { app } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
    });
    const res = await request(app).get('/ai-access');
    expect(res.text).toMatch(/readEditorToken|localStorage\.getItem/);
    expect(res.text).toMatch(/showAuthGate|auth-gate/);
    expect(res.text).toMatch(/Please sign in to Node-RED first/);
    // Must not silently bounce to the editor.
    expect(res.text).not.toMatch(/redirectToEditorLogin/);
  });

  it('client only opens auth gate on /status 401, not on other API 401s', async () => {
    const { app } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
    });
    const res = await request(app).get('/ai-access');
    expect(res.text).toMatch(/isStatusPath/);
    expect(res.text).toMatch(/Auth bootstrap: show a sign-in gate/);
    // Must not redirect on every 401 (that caused an /mcp ↔ editor loop).
    expect(res.text).not.toMatch(/if \(res\.status === 401\) \{\s*redirectToEditorLogin/);
    expect(res.text).toMatch(/filter-pending-count|dash-pending|Approve/);
  });

  it('admin session Bearer works on every /mcp/api/v1 route the page uses', async () => {
    // Simulates Chrome editor localStorage Bearer (not an aia_ access-link token).
    const editorBearer = 'nr-editor-access-token-not-an-access-link';
    const { app, linkStore } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
      authenticate: (req, _res, next) => {
        const auth = req.headers.authorization;
        if (auth === `Bearer ${editorBearer}`) {
          (req as Request & { user?: MockUser }).user = {
            username: 'admin',
            permissions: '*',
          };
        }
        next();
      },
    });

    // Seed a proposal via access link so GET /proposals has something to list.
    const link = linkStore.create({ kind: 'rest', label: 'seed' });
    const seeded = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Authorization', `Bearer ${link.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        payload: {
          flowId: 'tab-1',
          flow: { id: 'tab-1', type: 'tab', label: 'Main', nodes: [] },
        },
      });
    expect(seeded.status).toBe(201);

    const auth = { Authorization: `Bearer ${editorBearer}` };

    const status = await request(app).get('/mcp/api/v1/status').set(auth);
    expect(status.status).toBe(200);
    expect(status.body.caller).toMatchObject({ kind: 'admin', permission: '*' });

    const links = await request(app).get('/mcp/api/v1/links').set(auth);
    expect(links.status).toBe(200);
    expect(Array.isArray(links.body.links)).toBe(true);

    const logs = await request(app).get('/mcp/api/v1/logs?limit=100').set(auth);
    expect(logs.status).toBe(200);
    expect(Array.isArray(logs.body.logs)).toBe(true);

    // Regression: previously returned 401 access_link_invalid for editor Bearer.
    const proposals = await request(app).get('/mcp/api/v1/proposals').set(auth);
    expect(proposals.status).toBe(200);
    expect(proposals.body.proposals).toHaveLength(1);
    expect(proposals.body.code).toBeUndefined();
  });

  it('unknown aia_ Bearer on /proposals still returns access_link_invalid', async () => {
    const { app } = createApp({
      userDir,
      adminAuth: { type: 'credentials' },
      authenticate: asUser('*', 'admin'),
    });
    const res = await request(app)
      .get('/mcp/api/v1/proposals')
      .set('Authorization', 'Bearer aia_not-a-real-link-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('access_link_invalid');
  });
});
