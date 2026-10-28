import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import express, { type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/link-store.js';
import {
  resolveConflictChoice,
  resolveMyProposal,
  submitReplaceFlowProposal,
  withdrawMyProposal,
} from '../../src/plugin/ai-ops.js';
import { mapErrorForChannel } from '../../src/plugin/channel-errors.js';
import registerPlugin, { registerRoutes } from '../../src/plugin/index.js';
import { createAiMcpServer } from '../../src/plugin/mcp-rpc.js';
import { computeProposalDiff } from '../../src/plugin/proposal-diff.js';
import { presentProposalForApi } from '../../src/plugin/proposal-present.js';
import { ProposalService } from '../../src/plugin/proposal-service.js';
import {
  configureProposalTtl,
  createDebouncedSync,
  syncOpenProposals,
} from '../../src/plugin/proposal-sync.js';
import {
  recheckProposalHandler,
  resolveProposalConflictHandler,
  resolveProposalHandler,
} from '../../src/plugin/proposals-routes.js';
import { aiRedactingAdapter, redactProposalForAi } from '../../src/plugin/secret-redaction.js';
import { createPluginServices } from '../../src/plugin/services.js';
import { putSettingsHandler } from '../../src/plugin/settings-routes.js';
import type {
  AccessLinkAuthInfo,
  AuthenticatedRequest,
  NodeRedPluginAPI,
} from '../../src/plugin/types.js';
import { FlowRevisionConflictError } from '../../src/runtime/errors.js';
import { snapshotAdapter, withRevHistory } from '../../src/runtime/rev-history.js';
import type { FlowAdapter, FlowNode, FlowTab, FlowsSnapshot } from '../../src/runtime/types.js';
import { AuditLog } from '../../src/storage/audit-log.js';
import { ensureAiAccessDirs, resolveAiAccessPaths } from '../../src/storage/paths.js';
import { ProposalStore } from '../../src/storage/proposals.js';
import { SettingsStore, settingsJsPartial } from '../../src/storage/settings-store.js';

const base: FlowTab = {
  id: 'tab1',
  type: 'tab',
  label: 'Main',
  nodes: [
    { id: 'n1', type: 'function', func: 'return msg;', x: 10, y: 20, wires: [[]] },
    { id: 'n2', type: 'inject', name: 'tick', x: 10, y: 40, wires: [[]] },
  ],
};
const clone = <T>(v: T): T => structuredClone(v);
const flat = (flow: FlowTab): FlowNode[] => [
  { id: flow.id, type: flow.type ?? 'tab', label: flow.label },
  ...(flow.nodes ?? []).map(n => ({ ...n, z: flow.id })),
];
function response() {
  const result = { statusCode: 200, body: undefined as any };
  const res = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
  } as unknown as Response;
  return { res, result };
}
function req(body: unknown, id: string, accessLink?: AccessLinkAuthInfo): AuthenticatedRequest {
  return {
    body,
    params: { id },
    query: {},
    headers: {},
    app: { get: () => false },
    get: () => undefined,
    ...(accessLink ? { accessLink } : {}),
  } as unknown as AuthenticatedRequest;
}

describe('proposal auto-rebase wiring', () => {
  let dir: string;
  let store: ProposalStore;
  let audit: AuditLog;
  let head: FlowsSnapshot;
  let adapter: FlowAdapter;
  let updateFlow: ReturnType<typeof vi.fn>;
  let link: AccessLinkAuthInfo;
  let RED: NodeRedPluginAPI;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rebase-wiring-'));
    const paths = resolveAiAccessPaths(dir);
    ensureAiAccessDirs(paths);
    store = new ProposalStore(paths);
    audit = new AuditLog(paths);
    head = { rev: 'r1', flows: flat(clone(base)) };
    updateFlow = vi.fn(params => {
      head = { rev: `${head.rev}-next`, flows: flat(params.flow as FlowTab) };
      return Promise.resolve({ rev: head.rev });
    });
    adapter = withRevHistory({
      kind: 'red',
      getFlows: () => Promise.resolve(clone(head)),
      getFlow: id => snapshotAdapter(head, 'red').getFlow(id),
      updateFlow,
    });
    link = {
      id: 'link1',
      kind: 'rest',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    RED = {
      settings: { userDir: dir, adminAuth: { type: 'credentials' } },
      httpAdmin: express(),
      auth: { needsPermission: () => (_req, _res, next) => next() },
      plugins: { registerPlugin() {} },
      events: new EventEmitter(),
    };
    configureProposalTtl(() => 7);
  });
  afterEach(() => {
    vi.useRealTimers();
    configureProposalTtl(() => 7);
    rmSync(dir, { recursive: true, force: true });
  });
  async function submit() {
    const flow = clone(base);
    flow.nodes![0]!.func = 'msg.ai = true; return msg;';
    return submitReplaceFlowProposal(
      store,
      audit,
      link,
      { type: 'replace_flow', expectedRev: 'r1', payload: { flowId: 'tab1', flow } },
      adapter
    );
  }

  it('keeps unrelated global changes open and approves using the live revision', async () => {
    const p = await submit();
    head = { rev: 'r2', flows: [...head.flows, { id: 'other', type: 'tab' }] };
    await syncOpenProposals(store, adapter);
    expect(store.get(p.id)).toMatchObject({
      status: 'pending',
      rebase: { state: 'clean', rev: 'r2' },
    });
    await new ProposalService(store, audit, adapter, () => 'nodes').approve(p.id, {
      kind: 'admin',
    });
    expect(updateFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRev: 'r2',
        flow: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({ func: 'msg.ai = true; return msg;' }),
          ]),
        }),
      })
    );
  });

  it('requires the current mergedHash and preserves unrelated live nodes on deploy', async () => {
    const p = await submit();
    head.rev = 'r2';
    head.flows.push({ id: 'editor', type: 'debug', z: 'tab1', x: 100, y: 100, wires: [] });
    const service = new ProposalService(store, audit, adapter, () => 'nodes');
    let error: unknown;
    try {
      await service.approve(p.id, { kind: 'admin' });
    } catch (e) {
      error = e;
    }
    const mapped = mapErrorForChannel(error, 'rest');
    expect(mapped).toMatchObject({
      statusCode: 409,
      body: { code: 'rebase_ack_required', mergedHash: expect.any(String) },
    });
    expect(updateFlow).not.toHaveBeenCalled();
    const diff = await computeProposalDiff(store.get(p.id), adapter);
    expect(diff.liveChanges?.added.map(n => n.id)).toEqual(['editor']);
    expect(diff.vsCurrent?.added).toEqual([]);
    await expect(
      service.approve(p.id, { kind: 'admin' }, { mergedHash: 'outdated' })
    ).rejects.toMatchObject({ code: 'rebase_ack_required' });
    await service.approve(p.id, { kind: 'admin' }, { mergedHash: diff.rebase!.mergedHash! });
    expect(head.flows.some(n => n.id === 'editor')).toBe(true);
  });

  it.each(['live', 'proposed'] as const)(
    'reports conflict safely and resolves a manual %s choice',
    async choice => {
      const p = await submit();
      head.rev = 'r2';
      head.flows.find(n => n.id === 'n1')!.func =
        'const API_KEY = "live-secret-value"; return msg;';
      head.flows.find(n => n.id === 'n1')!.name = 'API_KEY="label-secret-value"';
      const service = new ProposalService(store, audit, adapter, () => 'nodes');
      await expect(service.approve(p.id, { kind: 'admin' })).rejects.toMatchObject({
        code: 'proposal_conflict',
      });
      expect(store.get(p.id).status).toBe('conflict');
      const diff = await computeProposalDiff(
        redactProposalForAi(store.get(p.id)),
        aiRedactingAdapter(adapter),
        store.get(p.id)
      );
      expect(diff.rebase?.state).toBe('conflict');
      expect(diff.vsCurrent).toBeUndefined();
      expect(JSON.stringify(diff)).not.toContain('live-secret-value');
      expect(JSON.stringify(diff)).not.toContain('label-secret-value');
      expect(
        JSON.stringify(presentProposalForApi(redactProposalForAi(store.get(p.id))))
      ).not.toContain('label-secret-value');
      const lean = presentProposalForApi(store.get(p.id));
      expect(lean.rebase?.conflicts[0]?.fields).toContain('func');
      expect(JSON.stringify(lean)).not.toContain('live-secret-value');
      const h = response();
      await resolveProposalConflictHandler(
        store,
        audit,
        adapter
      )(req({ nodeId: 'n1', choice }, p.id), h.res);
      expect(h.result.statusCode).toBe(200);
      expect(h.result.body.status).toBe('pending');
      const resolved = store.get(p.id);
      expect(resolved.payload.flow.nodes!.find(n => n.id === 'n1')!.func).toBe(
        choice === 'live' ? head.flows.find(n => n.id === 'n1')!.func : 'msg.ai = true; return msg;'
      );
      const missing = response();
      await resolveProposalConflictHandler(
        store,
        audit,
        adapter
      )(req({ nodeId: 'missing', choice }, p.id), missing.res);
      expect(missing.result).toMatchObject({
        statusCode: 409,
        body: { code: 'conflict_not_found' },
      });
      await expect(
        resolveConflictChoice(store, audit, { kind: 'admin' }, p.id, 'n1', 'bad', adapter)
      ).rejects.toMatchObject({ code: 'invalid_choice' });
    }
  );

  it('accepts known stale revisions but rejects never-seen revisions', async () => {
    await adapter.getFlows();
    head.rev = 'r2';
    head.flows.push({ id: 'other', type: 'tab' });
    const p = await submit();
    expect(p).toMatchObject({
      status: 'pending',
      expectedRev: 'r1',
      rebase: { rev: 'r2', state: 'clean' },
    });
    await expect(
      submitReplaceFlowProposal(
        store,
        audit,
        link,
        { type: 'replace_flow', expectedRev: 'unknown', payload: { flowId: 'tab1', flow: base } },
        adapter
      )
    ).rejects.toMatchObject({ code: 'version_mismatch' });
  });

  it('AI REST resolution checks ownership, keeps the flow id, and updates the title', async () => {
    const p = await submit();
    head.rev = 'r2';
    head.flows.find(n => n.id === 'n1')!.func = 'editor';
    await syncOpenProposals(store, adapter);
    await expect(
      resolveMyProposal(store, audit, { ...link, id: 'someone-else' }, p.id, {}, adapter)
    ).rejects.toMatchObject({ code: 'proposal_not_owned' });
    const h = response();
    await resolveProposalHandler(
      store,
      audit,
      adapter
    )(
      req(
        {
          expectedRev: 'r2',
          title: 'Resolved title',
          nodes: [{ op: 'set', id: 'n1', set: { func: 'resolved' } }],
        },
        p.id,
        link
      ),
      h.res
    );
    expect(h.result).toMatchObject({
      statusCode: 200,
      body: { status: 'pending', storedTitle: 'Resolved title', mine: true },
    });
    expect(store.get(p.id).payload.flow.nodes!.find(n => n.id === 'n1')!.func).toBe('resolved');
    const wrongFlow = { id: 'other', type: 'tab', nodes: [] };
    head.flows.push({ id: 'other', type: 'tab' });
    await expect(
      resolveMyProposal(
        store,
        audit,
        link,
        p.id,
        { expectedRev: 'r2', payload: { flowId: 'other', flow: wrongFlow } },
        adapter
      )
    ).rejects.toMatchObject({ code: 'flow_id_mismatch' });
  });

  it('recheck keeps closed records closed, and conflict proposals can be withdrawn', async () => {
    const p = await submit();
    head.rev = 'r2';
    head.flows.find(n => n.id === 'n1')!.func = 'editor';
    const h = response();
    await recheckProposalHandler(store, adapter)(req({}, p.id), h.res);
    expect(h.result.body.status).toBe('conflict');
    const withdrawn = withdrawMyProposal(store, audit, link, p.id, 'done');
    expect(withdrawn.status).toBe('withdrawn');
    await syncOpenProposals(store, adapter);
    expect(store.get(p.id).status).toBe('withdrawn');
  });

  it('expires pending and conflict proposals only by configured age, without reopening legacy closed records', async () => {
    const p = await submit();
    const settings = new SettingsStore(resolveAiAccessPaths(dir));
    settings.patch({ proposalTtlDays: 2 });
    let now = Date.now();
    configureProposalTtl(
      () => settings.getEffective().proposalTtlDays,
      () => now
    );
    head.rev = 'r2';
    head.flows.find(n => n.id === 'n1')!.func = 'editor';
    await syncOpenProposals(store, adapter);
    expect(store.get(p.id).status).toBe('conflict');
    now += 3 * 86_400_000;
    expect((await syncOpenProposals(store, adapter)).expired).toBe(1);
    expect(store.get(p.id)).toMatchObject({
      status: 'expired',
      reason: expect.stringContaining('2 days'),
    });
    head.rev = 'r1';
    await syncOpenProposals(store, adapter);
    expect(store.get(p.id).status).toBe('expired');
  });

  it('validates and persists the TTL setting and honors settings.js locks', () => {
    const settings = new SettingsStore(resolveAiAccessPaths(dir));
    expect(settings.getEffective().proposalTtlDays).toBe(7);
    for (const invalid of [0, 366, 1.5, '7']) {
      const h = response();
      putSettingsHandler(
        RED,
        settings,
        new AccessLinkStore()
      )(req({ proposalTtlDays: invalid }, ''), h.res);
      expect(h.result.statusCode).toBe(400);
    }
    settings.patch({ proposalTtlDays: 365 });
    expect(new SettingsStore(resolveAiAccessPaths(dir)).getEffective().proposalTtlDays).toBe(365);
    expect(
      new SettingsStore(resolveAiAccessPaths(dir), { proposalTtlDays: 1 }).getEffective()
        .proposalTtlDays
    ).toBe(1);
    expect(settingsJsPartial({ proposalTtlDays: 1.5 }).proposalTtlDays).toBe(7);
  });

  it('debounces deploy events and removes its listener and timer on plugin removal', async () => {
    vi.useFakeTimers();
    const defs: Record<string, unknown>[] = [];
    RED.plugins.registerPlugin = (_id, def) => {
      if (def) defs.push(def);
    };
    registerPlugin(RED);
    // Direct route registrations replace the previous rebase listener.
    registerRoutes(RED, { flowAdapter: adapter });
    registerRoutes(RED, { flowAdapter: adapter });
    const emitter = RED.events as EventEmitter;
    expect(emitter.listeners('flows:started').filter(fn => fn.name === 'trigger')).toHaveLength(1);
    const p = await submit();
    head.rev = 'r2';
    head.flows.find(n => n.id === 'n1')!.func = 'editor';
    emitter.emit('flows:started');
    emitter.emit('flows:started');
    await vi.advanceTimersByTimeAsync(499);
    expect(store.get(p.id).status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(store.get(p.id).status).toBe('conflict');
    emitter.emit('flows:started');
    (defs[0]!.onremove as () => void)();
    expect(emitter.listeners('flows:started').filter(fn => fn.name === 'trigger')).toHaveLength(0);
    const run = vi.fn(() => Promise.resolve());
    const sync = createDebouncedSync(run);
    sync.trigger();
    sync.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).not.toHaveBeenCalled();
  });

  it('MCP lists conflict resolution and resolves an owned proposal using the live tool', async () => {
    const services = createPluginServices(RED, { flowAdapter: adapter });
    const p = await submitReplaceFlowProposal(
      services.proposalStore,
      services.auditLog,
      link,
      { type: 'replace_flow', expectedRev: 'r1', payload: { flowId: 'tab1', flow: base } },
      services.flowAdapter
    );
    const server = createAiMcpServer(RED, services, req({}, '', link));
    const client = new Client({ name: 'rebase-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      const { tools } = await client.listTools();
      expect(tools.some(t => t.name === 'resolve_proposal_conflict')).toBe(true);
      const result = await client.callTool({
        name: 'resolve_proposal_conflict',
        arguments: {
          id: p.id,
          expectedRev: 'r1',
          payload: {
            flowId: 'tab1',
            nodes: [{ op: 'set', id: 'n1', set: { func: 'MCP resolution' } }],
          },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(
        services.proposalStore.get(p.id).payload.flow.nodes!.find(n => n.id === 'n1')!.func
      ).toBe('MCP resolution');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('exhausts rev race retries without closing the proposal', async () => {
    const p = await submit();
    updateFlow.mockRejectedValue(new FlowRevisionConflictError('r1', 'r2'));
    await expect(
      new ProposalService(store, audit, adapter, () => 'nodes').approve(p.id, { kind: 'admin' })
    ).rejects.toMatchObject({ code: 'rebase_race' });
    expect(updateFlow).toHaveBeenCalledTimes(3);
    expect(store.get(p.id).status).toBe('pending');
  });
});
