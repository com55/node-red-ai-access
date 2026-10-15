/**
 * Regression coverage for AI-user test findings (flow_not_found, chunk data,
 * wires, diff presence, draft rev/submit, Bearer bogus, format=summary, etc.).
 */

import { createHash } from 'node:crypto';
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
} from '../../src/plugin/access-link-auth.js';
import { applyDiffFormat, resolveDiffFormat } from '../../src/plugin/diff-format.js';
import { registerRoutes } from '../../src/plugin/index.js';
import { buildProposalDiff } from '../../src/plugin/proposal-diff.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import { FlowNotFoundError } from '../../src/runtime/errors.js';
import type { FlowAdapter, FlowTab } from '../../src/runtime/types.js';
import type { Proposal } from '../../src/storage/proposals.js';

function createApp(options: {
  userDir: string;
  adapter?: FlowAdapter;
  authenticate?: (req: Request, _res: Response, next: NextFunction) => void;
  passportStyle401?: boolean;
}): {
  app: Express;
  linkStore: AccessLinkStore;
  adapter: FlowAdapter;
} {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 20, defaultTtlSeconds: 14_400 });

  const flow: FlowTab = {
    id: 'tab-1',
    type: 'tab',
    label: 'Main',
    nodes: [
      { id: 'n1', type: 'inject', z: 'tab-1', name: 'Kick', x: 100, y: 80, wires: [['n2']] },
      {
        id: 'n2',
        type: 'template',
        z: 'tab-1',
        name: 'Tpl',
        template: '<p>hi</p>',
        x: 280,
        y: 80,
        wires: [[]],
      },
    ],
  };

  let liveRev = 'rev-1';

  const adapter: FlowAdapter =
    options.adapter ??
    ({
      kind: 'red',
      getFlows: () =>
        Promise.resolve({
          rev: liveRev,
          flows: [{ id: 'tab-1', type: 'tab', label: 'Main' }],
        }),
      getFlow: (id: string) => {
        if (id !== 'tab-1') {
          return Promise.reject(new FlowNotFoundError(id));
        }
        return Promise.resolve({
          rev: liveRev,
          flow: {
            ...flow,
            id,
            nodes: flow.nodes?.map(n => ({ ...n, wires: structuredClone(n.wires) })),
          },
        });
      },
      updateFlow: () => {
        liveRev = 'rev-2';
        return Promise.resolve({ rev: liveRev });
      },
      /** Test helper to bump rev without updating. */
      _setRev: (rev: string) => {
        liveRev = rev;
      },
    } as FlowAdapter & { _setRev?: (rev: string) => void });

  const authenticate =
    options.authenticate ??
    ((_req: Request, res: Response, _next: NextFunction) => {
      if (options.passportStyle401) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="Users"');
        res.status(401).end('Unauthorized');
        return;
      }
      res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
    });

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir: options.userDir,
      httpAdminRoot: '/',
      adminAuth: { type: 'credentials' },
      aiAccess: { defaultDeploymentType: 'nodes', defaultLinkTtlSeconds: 14_400 },
    },
    httpAdmin: app,
    auth: {
      needsPermission(_permission: string) {
        return (req: Request, res: Response, next: NextFunction) => {
          authenticate(req, res, (err?: unknown) => {
            if (err) {
              next(err as Error);
              return;
            }
            next();
          });
        };
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
  return { app, linkStore, adapter };
}

function bumpRev(adapter: FlowAdapter, rev: string): void {
  const setter = (adapter as FlowAdapter & { _setRev?: (r: string) => void })._setRev;
  setter?.(rev);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function proposal(partial: Partial<Proposal> & Pick<Proposal, 'payload'>): Proposal {
  return {
    id: 'prop-abc123456789',
    type: 'replace_flow',
    status: 'pending',
    expectedRev: 'rev-1',
    createdBy: { kind: 'access-link', linkId: 'link-1', label: 'agent' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('AI-user findings', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-findings-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  describe('1. unknown flow id → 404 flow_not_found', () => {
    it('GET-link and REST return 404 with hint', async () => {
      const { app, linkStore } = createApp({ userDir, passportStyle401: true });
      const link = linkStore.create({ label: 'f1' });

      const getLink = await request(app).get(`/mcp/a/${link.token}/flows/missing-tab`);
      expect(getLink.status).toBe(404);
      expect(getLink.body.code).toBe('flow_not_found');
      expect(String(getLink.body.hint)).toMatch(/GET \.\/flows/);
      expect(getLink.body).not.toMatchObject({ code: 'upstream_error' });

      const rest = await request(app)
        .get('/mcp/api/v1/flows/missing-tab')
        .set('Authorization', `Bearer ${link.token}`);
      expect(rest.status).toBe(404);
      expect(rest.body.code).toBe('flow_not_found');
      expect(String(rest.body.hint)).toMatch(/GET \/flows|GET \.\/flows/);
    });
  });

  describe('2. invalid base64url chunk → 400 invalid_chunk_data', () => {
    it('rejects @@@ and does not store the seq', async () => {
      const { app, linkStore } = createApp({ userDir });
      const link = linkStore.create({ label: 'f2' });
      const created = await request(app).get(
        `/mcp/a/${link.token}/draft/new?flow=tab-1&rev=rev-1&node=n2&field=template`
      );
      const draftId = created.body.draftId as string;

      const bad = await request(app).get(
        `/mcp/a/${link.token}/draft/${draftId}/append?seq=0&data=${encodeURIComponent('@@@')}`
      );
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('invalid_chunk_data');
      expect(bad.body.receivedSeqs ?? []).not.toContain(0);

      const good = Buffer.from('ok', 'utf8').toString('base64url');
      const ok = await request(app).get(
        `/mcp/a/${link.token}/draft/${draftId}/append?seq=0&data=${good}`
      );
      expect(ok.status).toBe(200);
      expect(ok.body.receivedSeqs).toEqual([0]);
      expect(ok.body.totalBytes).toBe(2);
    });
  });

  describe('3. set.wires allowed when targets exist', () => {
    it('accepts validated wires in propose patch', async () => {
      const { app, linkStore } = createApp({ userDir });
      const link = linkStore.create({ label: 'f3' });
      const patch = {
        nodes: [{ op: 'set', id: 'n1', set: { wires: [['n2']] } }],
      };
      const encoded = Buffer.from(JSON.stringify(patch), 'utf8').toString('base64url');
      const res = await request(app).get(
        `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&patch=${encoded}`
      );
      expect(res.status).toBe(201);
      const n1 = res.body.proposal.payload.flow.nodes.find((n: { id: string }) => n.id === 'n1');
      expect(n1.wires).toEqual([['n2']]);
    });

    it('rejects wires to unknown targets', async () => {
      const { app, linkStore } = createApp({ userDir });
      const link = linkStore.create({ label: 'f3-bad' });
      const patch = {
        nodes: [{ op: 'set', id: 'n1', set: { wires: [['missing-node']] } }],
      };
      const encoded = Buffer.from(JSON.stringify(patch), 'utf8').toString('base64url');
      const res = await request(app).get(
        `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&patch=${encoded}`
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_wires');
    });

    it('allows wires to a node added in the same patch', async () => {
      const { app, linkStore } = createApp({ userDir });
      const link = linkStore.create({ label: 'f3-add' });
      const patch = {
        nodes: [
          {
            op: 'add',
            node: { id: 'n9', type: 'debug', z: 'tab-1', name: 'out', wires: [[]] },
          },
          { op: 'set', id: 'n1', set: { wires: [['n9']] } },
        ],
      };
      const encoded = Buffer.from(JSON.stringify(patch), 'utf8').toString('base64url');
      const res = await request(app).get(
        `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&patch=${encoded}`
      );
      expect(res.status).toBe(201);
      const n1 = res.body.proposal.payload.flow.nodes.find((n: { id: string }) => n.id === 'n1');
      expect(n1.wires).toEqual([['n9']]);
    });
  });

  describe('4. added node diff includes wires and x/y', () => {
    it('puts wires (readable) and x/y in properties and keyFields', () => {
      const diff = buildProposalDiff(
        proposal({
          baseFlow: { id: 'tab-1', label: 'Main', nodes: [] },
          payload: {
            flowId: 'tab-1',
            flow: {
              id: 'tab-1',
              label: 'Main',
              nodes: [
                {
                  id: 'nNew',
                  type: 'inject',
                  name: 'start',
                  x: 120,
                  y: 200,
                  wires: [['nDbg']],
                },
                { id: 'nDbg', type: 'debug', name: 'out', wires: [[]] },
              ],
            },
          },
        }),
        { rev: 'rev-1', flow: { id: 'tab-1', nodes: [] } },
        { compareAgainst: 'base' }
      );

      const added = diff.added.find(n => n.id === 'nNew');
      expect(added).toBeTruthy();
      expect(added?.properties.some(p => p.key === 'x' && p.value === 120)).toBe(true);
      expect(added?.properties.some(p => p.key === 'y' && p.value === 200)).toBe(true);
      const wiresProp = added?.properties.find(p => p.key === 'wires');
      expect(wiresProp?.value).toBe('out');
      const wiresKey = added?.keyFields.find(p => p.key === 'wires');
      expect(wiresKey?.value).toBe('out');
    });
  });

  describe('5. draft/new rev check + stale submit draftDeleted', () => {
    it('draft/new returns 409 version_mismatch immediately on stale rev', async () => {
      const { app, linkStore } = createApp({ userDir });
      const link = linkStore.create({ label: 'f5-new' });
      const res = await request(app).get(
        `/mcp/a/${link.token}/draft/new?flow=tab-1&rev=stale&node=n2&field=template`
      );
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('version_mismatch');
      expect(res.body.currentRev).toBe('rev-1');
      expect(res.body.expectedRev).toBe('stale');
    });

    it('stale submit reports draftDeleted: false', async () => {
      const { app, linkStore, adapter } = createApp({ userDir });
      const link = linkStore.create({ label: 'f5-sub' });
      const created = await request(app).get(
        `/mcp/a/${link.token}/draft/new?flow=tab-1&rev=rev-1&node=n2&field=template`
      );
      const draftId = created.body.draftId as string;
      const body = 'kept-draft-content';
      const data = Buffer.from(body, 'utf8').toString('base64url');
      await request(app).get(`/mcp/a/${link.token}/draft/${draftId}/append?seq=0&data=${data}`);
      bumpRev(adapter, 'rev-moved');

      const submitted = await request(app).get(
        `/mcp/a/${link.token}/draft/${draftId}/submit?sha256=${sha256Hex(body)}`
      );
      expect(submitted.status).toBe(409);
      expect(submitted.body.code).toBe('version_mismatch');
      expect(submitted.body.draftDeleted).toBe(false);
      expect(String(submitted.body.hint)).toMatch(/kept|not deleted|Draft was kept/i);
    });
  });

  describe('6. REST Bearer bogus → access_link_invalid', () => {
    it('does not return access_link_missing for garbled Bearer', async () => {
      const { app } = createApp({ userDir, passportStyle401: true });
      const res = await request(app).get('/mcp/api/v1/flows').set('Authorization', 'Bearer bogus');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe(ACCESS_LINK_INVALID_CODE);
      expect(res.body.error).toBe(ACCESS_LINK_INVALID_MESSAGE);
      expect(res.body.code).not.toBe('access_link_missing');
    });
  });

  describe('7. diff format=summary default compact', () => {
    it('resolveDiffFormat defaults to summary', () => {
      expect(resolveDiffFormat(undefined)).toBe('summary');
      expect(resolveDiffFormat('summary')).toBe('summary');
      expect(resolveDiffFormat('full')).toBe('full');
    });

    it('summary truncates large equal runs and adds byte sizes', () => {
      const equalBlock = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');
      const before = `${equalBlock}\nold\n${equalBlock}`;
      const after = `${equalBlock}\nnew\n${equalBlock}`;
      const raw = buildProposalDiff(
        proposal({
          baseFlow: {
            nodes: [{ id: 'n1', type: 'function', func: before }],
          },
          payload: {
            flowId: 'tab-1',
            flow: { nodes: [{ id: 'n1', type: 'function', func: after }] },
          },
        }),
        { rev: 'rev-1', flow: { nodes: [{ id: 'n1', type: 'function', func: before }] } }
      );

      const summary = applyDiffFormat(raw, 'summary');
      const change = summary.modified[0]?.changes[0];
      expect(summary.format).toBe('summary');
      expect(change?.kind).toBe('text');
      if (change?.kind === 'text') {
        expect(change.beforeBytes).toBe(Buffer.byteLength(before, 'utf8'));
        expect(change.afterBytes).toBe(Buffer.byteLength(after, 'utf8'));
        expect(change.truncated).toBe(true);
        expect(change.lines.length).toBeLessThan(
          raw.modified[0]!.changes[0]!.kind === 'text'
            ? (raw.modified[0]!.changes[0] as { lines: unknown[] }).lines.length
            : 999
        );
        expect(change.lines.some(l => l.text.includes('unchanged line'))).toBe(true);
      }

      const full = applyDiffFormat(raw, 'full');
      const fullChange = full.modified[0]?.changes[0];
      if (fullChange?.kind === 'text') {
        expect(fullChange.truncated).toBeUndefined();
        expect(fullChange.lines.length).toBeGreaterThan(
          change!.kind === 'text' ? change!.lines.length : 0
        );
      }
    });

    it('GET diff defaults to summary and accepts format=full', async () => {
      const { app, linkStore } = createApp({ userDir });
      const link = linkStore.create({ label: 'f7' });
      const pad = Array.from({ length: 30 }, (_, i) => `keep-${i}`).join('\n');
      const after = `${pad}\nnew\n${pad}`;
      const created = await request(app)
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
              nodes: [
                { id: 'n1', type: 'inject', z: 'tab-1', name: 'Kick', wires: [['n2']] },
                {
                  id: 'n2',
                  type: 'template',
                  z: 'tab-1',
                  name: 'Tpl',
                  template: after,
                  wires: [[]],
                },
              ],
            },
          },
        });
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      const def = await request(app).get(`/mcp/a/${link.token}/proposals/${id}/diff`);
      expect(def.status).toBe(200);
      expect(def.body.format).toBe('summary');
      const textChange = (def.body.modified ?? [])
        .flatMap(
          (m: { changes?: { kind?: string; beforeBytes?: number; afterBytes?: number }[] }) =>
            m.changes ?? []
        )
        .find((c: { kind?: string }) => c.kind === 'text');
      expect(textChange).toBeTruthy();
      expect(typeof textChange.beforeBytes).toBe('number');
      expect(typeof textChange.afterBytes).toBe('number');

      const full = await request(app).get(`/mcp/a/${link.token}/proposals/${id}/diff?format=full`);
      expect(full.status).toBe(200);
      expect(full.body.format).toBe('full');
    });
  });

  describe('8. re-submit draft → draft_already_submitted + proposalId', () => {
    it('returns 409 with proposalId on second submit', async () => {
      const { app, linkStore } = createApp({ userDir });
      const link = linkStore.create({ label: 'f8' });
      const body = '<p>once</p>';
      const created = await request(app).get(
        `/mcp/a/${link.token}/draft/new?flow=tab-1&rev=rev-1&node=n2&field=template`
      );
      const draftId = created.body.draftId as string;
      const data = Buffer.from(body, 'utf8').toString('base64url');
      await request(app).get(`/mcp/a/${link.token}/draft/${draftId}/append?seq=0&data=${data}`);
      const first = await request(app).get(
        `/mcp/a/${link.token}/draft/${draftId}/submit?sha256=${sha256Hex(body)}`
      );
      expect(first.status).toBe(201);
      const proposalId = first.body.proposal.id as string;

      const second = await request(app).get(
        `/mcp/a/${link.token}/draft/${draftId}/submit?sha256=${sha256Hex(body)}`
      );
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('draft_already_submitted');
      expect(second.body.proposalId).toBe(proposalId);
    });
  });

  describe('9. malformed sha256 → 400 invalid_sha256', () => {
    it('rejects short or non-hex sha256', async () => {
      const { app, linkStore } = createApp({ userDir });
      const link = linkStore.create({ label: 'f9' });
      const created = await request(app).get(
        `/mcp/a/${link.token}/draft/new?flow=tab-1&rev=rev-1&node=n2&field=template`
      );
      const draftId = created.body.draftId as string;
      const data = Buffer.from('x', 'utf8').toString('base64url');
      await request(app).get(`/mcp/a/${link.token}/draft/${draftId}/append?seq=0&data=${data}`);

      const bad = await request(app).get(
        `/mcp/a/${link.token}/draft/${draftId}/submit?sha256=not-a-hash`
      );
      expect(bad.status).toBe(400);
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('invalid_sha256');
      expect(String(bad.body.error)).toMatch(/expected 64 hex chars/i);
    });
  });

  describe('10. truncated token 401 hint', () => {
    it('mentions truncation for short/garbled tokens (REST + GET-link)', async () => {
      const { app } = createApp({ userDir, passportStyle401: true });

      const rest = await request(app).get('/mcp/api/v1/flows').set('Authorization', 'Bearer bog');
      expect(rest.status).toBe(401);
      expect(rest.body.code).toBe(ACCESS_LINK_INVALID_CODE);
      expect(String(rest.body.hint)).toMatch(/truncated/i);

      const getLink = await request(app).get('/mcp/a/aia_short/status');
      expect(getLink.status).toBe(401);
      expect(getLink.body.code).toBe(ACCESS_LINK_INVALID_CODE);
      expect(String(getLink.body.hint)).toMatch(/truncated/i);
    });
  });

  describe('11. siblingsOnSameRev on propose', () => {
    it('includes siblingsOnSameRev warning when another pending shares rev', async () => {
      const { app, linkStore } = createApp({ userDir });
      const link = linkStore.create({ label: 'f11' });

      const first = await request(app).get(
        `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&node=n1&set.name=One&title=first`
      );
      expect(first.status).toBe(201);

      const second = await request(app).get(
        `/mcp/a/${link.token}/propose?flow=tab-1&rev=rev-1&node=n1&set.name=Two&title=second`
      );
      expect(second.status).toBe(201);
      expect(second.body.siblingsOnSameRev).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: first.body.proposal.id })])
      );
      expect(String(second.body.warning)).toMatch(/approve order|same flow revision/i);

      const docs = await request(app).get(`/mcp/a/${link.token}`);
      expect(docs.text).toMatch(/siblingsOnSameRev/);
    });
  });
});
