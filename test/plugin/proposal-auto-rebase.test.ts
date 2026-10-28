import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { adapterAtRev, submitReplaceFlowProposal } from '../../src/plugin/ai-ops.js';
import {
  ProposalRebaseAckRequiredError,
  ProposalService,
} from '../../src/plugin/proposal-service.js';
import { registerRoutes } from '../../src/plugin/index.js';
import {
  configureProposalTtl,
  syncOneProposal,
  syncOpenProposals,
} from '../../src/plugin/proposal-sync.js';
import { aiRedactingAdapter } from '../../src/plugin/secret-redaction.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import { FlowRevisionConflictError } from '../../src/runtime/errors.js';
import { replaceFlowTabInFlatFlows } from '../../src/runtime/flows-util.js';
import { snapshotAdapter, withRevHistory } from '../../src/runtime/rev-history.js';
import type {
  FlowAdapter,
  FlowNode,
  FlowsSnapshot,
  UpdateFlowParams,
} from '../../src/runtime/types.js';
import { AuditLog } from '../../src/storage/audit-log.js';
import { resolveAiAccessPaths } from '../../src/storage/paths.js';
import { ProposalStore } from '../../src/storage/proposals.js';

const clone = <T>(v: T): T => structuredClone(v);
const initial: FlowNode[] = [
  { id: 'tab', type: 'tab', label: 'Main', env: [] },
  { id: 'a', type: 'function', func: 'return msg;', x: 10, y: 20, wires: [[]], z: 'tab' },
  { id: 'b', type: 'debug', name: 'base', x: 30, y: 40, wires: [], z: 'tab' },
];

describe('auto-rebase service and HTTP API', () => {
  let dir: string, app: ReturnType<typeof express>, store: ProposalStore, audit: AuditLog;
  let adapter: FlowAdapter, head: FlowsSnapshot, token: string, events: EventEmitter;
  let linkStore: AccessLinkStore;
  let updateFlow: ReturnType<typeof vi.fn>;
  let beforeUpdate: ((params: UpdateFlowParams) => Promise<void>) | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auto-rebase-api-'));
    head = { rev: 'r1', flows: clone(initial) };
    beforeUpdate = undefined;
    updateFlow = vi.fn(async (params: UpdateFlowParams) => {
      await beforeUpdate?.(params);
      if (params.expectedRev !== head.rev)
        throw new FlowRevisionConflictError(params.expectedRev, head.rev);
      head = {
        rev: `${head.rev}-deploy`,
        flows: replaceFlowTabInFlatFlows(head.flows, params.flowId, params.flow),
      };
      return { flowId: params.flowId, rev: head.rev };
    });
    adapter = withRevHistory({
      kind: 'red',
      getFlows: async () => clone(head),
      getFlow: id => snapshotAdapter(head, 'red').getFlow(id),
      updateFlow,
    });
    app = express();
    app.use(express.json());
    events = new EventEmitter();
    linkStore = new AccessLinkStore();
    const RED: NodeRedPluginAPI = {
      settings: {
        userDir: dir,
        adminAuth: { type: 'credentials' },
        aiAccess: { defaultDeploymentType: 'nodes' },
      },
      httpAdmin: app,
      events,
      auth: {
        needsPermission: () => (req, _res, next) => {
          Object.assign(req, { user: { username: 'admin', permissions: '*' } });
          next();
        },
      },
      plugins: { registerPlugin() {} },
    };
    registerRoutes(RED, { flowAdapter: adapter, linkStore });
    token = linkStore.create({ kind: 'rest', label: 'AI' }).token;
    const paths = resolveAiAccessPaths(dir);
    store = new ProposalStore(paths);
    audit = new AuditLog(paths);
  });
  afterEach(() => {
    vi.useRealTimers();
    configureProposalTtl(() => 7);
    events.removeAllListeners();
    rmSync(dir, { recursive: true, force: true });
  });
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const submit = (
    id = 'a',
    expectedRev = 'r1',
    set: Record<string, unknown> = { func: 'proposal' }
  ) =>
    request(app)
      .post('/mcp/api/v1/proposals')
      .set(auth())
      .send({
        type: 'replace_flow',
        expectedRev,
        payload: { flowId: 'tab', nodes: [{ op: 'set', id, set }] },
      });
  const approve = (id: string, body = {}) =>
    request(app).post(`/mcp/api/v1/proposals/${id}/approve`).send(body);
  const list = () => request(app).get('/mcp/api/v1/proposals').set(auth());
  function edit(id: string, values: Record<string, unknown>) {
    Object.assign(
      head.flows.find(n => n.id === id)!,
      values
    );
    head.rev += '-editor';
  }

  it('keeps proposals pending when a new tab is created elsewhere and deploys using the live rev', async () => {
    const p = await submit();
    expect(p.status).toBe(201);
    head.flows.push({ id: 'new-tab', type: 'tab', label: 'New tab' });
    head.rev = 'r2';
    const listed = await list();
    expect(listed.status).toBe(200);
    expect(
      listed.body.proposals.find((candidate: { id: string }) => candidate.id === p.body.id)
    ).toMatchObject({ status: 'pending', rebase: { state: 'clean', rev: 'r2' } });
    expect((await approve(p.body.id)).body.status).toBe('approved');
    expect(updateFlow).toHaveBeenCalledWith(expect.objectContaining({ expectedRev: 'r2' }));
    expect(head.flows.find(n => n.id === 'new-tab')!.label).toBe('New tab');
    expect(head.flows.find(n => n.id === 'a')!.func).toBe('proposal');
  });

  it('submits, stays pending, and approves a same-node edit retaining a literal live placeholder', async () => {
    Object.assign(
      head.flows.find(n => n.id === 'a')!,
      { name: 'Literal target', password: '[REDACTED]' }
    );
    const read = await request(app).get('/mcp/api/v1/flows/tab').set(auth());
    expect(read.status).toBe(200);
    const flow = read.body.flow;
    expect(flow.nodes.find((n: FlowNode) => n.id === 'a').password).toBe('[REDACTED]');
    flow.nodes.find((n: FlowNode) => n.id === 'a').name = 'Literal target proposed';
    const submitted = await request(app)
      .post('/mcp/api/v1/proposals')
      .set(auth())
      .send({
        type: 'replace_flow',
        expectedRev: read.body.rev,
        payload: { flowId: 'tab', flow },
      });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    expect(submitted.body.status).toBe('pending');
    const id = submitted.body.id;
    expect(store.get(id).payload.flow?.nodes?.find(n => n.id === 'a')).toMatchObject({
      name: 'Literal target proposed',
      password: '[REDACTED]',
    });
    const listed = await list();
    expect(listed.status).toBe(200);
    expect(listed.body.proposals.find((p: { id: string }) => p.id === id)).toMatchObject({
      status: 'pending',
      rebase: { state: 'clean', conflicts: [] },
    });
    expect(updateFlow).not.toHaveBeenCalled();
    const approved = await approve(id);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(store.get(id).status).toBe('approved');
    expect(head.flows.find(n => n.id === 'a')).toMatchObject({
      name: 'Literal target proposed',
      password: '[REDACTED]',
      func: 'return msg;',
    });
  });

  it('requires and accepts mergedHash acknowledgement and retains disjoint live edits', async () => {
    const p = await submit();
    edit('b', { name: 'live' });
    const missing = await approve(p.body.id);
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('rebase_ack_required');
    expect(updateFlow).not.toHaveBeenCalled();
    const wrong = await approve(p.body.id, { mergedHash: '0000000000000000' });
    expect(wrong.status).toBe(409);
    const ok = await approve(p.body.id, { mergedHash: missing.body.mergedHash });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect(head.flows.find(n => n.id === 'b')!.name).toBe('live');
    expect(head.flows.find(n => n.id === 'a')!.func).toBe('proposal');
  });

  it('rebases other open proposals on the same flow after approval, allowing both changes to deploy', async () => {
    const a = await submit(),
      b = await submit('b', 'r1', { name: 'second' });
    expect((await approve(a.body.id)).status).toBe(200);
    expect(store.get(b.body.id)).toMatchObject({
      status: 'pending',
      rebase: { state: 'merged', rev: head.rev },
    });
    const done = await approve(b.body.id, { mergedHash: store.get(b.body.id).rebase!.mergedHash });
    expect(done.body.status).toBe('approved');
    expect(head.flows.find(n => n.id === 'a')!.func).toBe('proposal');
    expect(head.flows.find(n => n.id === 'b')!.name).toBe('second');
  });

  it('serializes simultaneous approvals across service instances and retains both node edits', async () => {
    const a = await submit(),
      b = await submit('b', 'r1', { name: 'second' });
    updateFlow.mockImplementation(async (params: UpdateFlowParams) => {
      // Like the runtime adapters, check the rev before an asynchronous write.
      if (params.expectedRev !== head.rev)
        throw new FlowRevisionConflictError(params.expectedRev, head.rev);
      const flows = replaceFlowTabInFlatFlows(head.flows, params.flowId, params.flow);
      await new Promise(resolve => setTimeout(resolve, 20));
      head = { rev: `${head.rev}-deploy`, flows };
      return { flowId: params.flowId, rev: head.rev };
    });
    const services = [
      new ProposalService(store, audit, adapter, () => 'nodes'),
      new ProposalService(store, audit, adapter, () => 'nodes'),
    ];
    const results = await Promise.all(
      [a.body.id, b.body.id].map(async (id, index) => {
        const service = services[index]!;
        try {
          return await service.approve(id, { kind: 'admin' });
        } catch (error) {
          if (!(error instanceof ProposalRebaseAckRequiredError)) throw error;
          // The queued proposal must acknowledge the merge with the first deploy.
          return service.approve(id, { kind: 'admin' }, { mergedHash: error.mergedHash });
        }
      })
    );
    expect(results.map(p => p.status)).toEqual(['approved', 'approved']);
    expect(updateFlow).toHaveBeenCalledTimes(2);
    expect(head.flows.find(n => n.id === 'a')!.func).toBe('proposal');
    expect(head.flows.find(n => n.id === 'b')!.name).toBe('second');
    expect(updateFlow.mock.calls.map(c => c[0].expectedRev)).toEqual(['r1', 'r1-deploy']);
  });

  it.each(['read', 'deployment setting'])(
    'releases approval locks after a %s error',
    async failure => {
      const p = await submit();
      const service = new ProposalService(store, audit, adapter, () => {
        if (failure === 'deployment setting') throw new Error('setting unavailable');
        return 'nodes';
      });
      if (failure === 'read')
        vi.spyOn(adapter, 'getFlows').mockRejectedValueOnce(new Error('runtime unavailable'));
      await expect(service.approve(p.body.id, { kind: 'admin' })).rejects.toThrow('unavailable');
      expect(store.isApproving(p.body.id)).toBe(false);
      const retry = new ProposalService(store, audit, adapter, () => 'nodes');
      expect((await retry.approve(p.body.id, { kind: 'admin' })).status).toBe('approved');
    }
  );

  it('retries a revision race during updateFlow and succeeds against the new revision', async () => {
    const p = await submit();
    beforeUpdate = async () => {
      beforeUpdate = undefined;
      head.rev = 'r2';
      head.flows.push({ id: 'other', type: 'tab' });
    };
    const result = await approve(p.body.id);
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('approved');
    expect(updateFlow.mock.calls.map(c => c[0].expectedRev)).toEqual(['r1', 'r2']);
    expect(head.flows.some(n => n.id === 'other')).toBe(true);
  });

  it('stops after three real races, returns rebase_race and keeps the proposal pending', async () => {
    const p = await submit();
    beforeUpdate = async () => {
      head.rev += '-raced';
    };
    const result = await approve(p.body.id);
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('rebase_race');
    expect(updateFlow).toHaveBeenCalledTimes(3);
    expect(store.get(p.body.id).status).toBe('pending');
    beforeUpdate = undefined;
    expect((await approve(p.body.id)).body.status).toBe('approved');
  });

  it('stops retrying when a race introduces a conflict', async () => {
    const p = await submit();
    beforeUpdate = async () => {
      beforeUpdate = undefined;
      edit('a', { func: 'live' });
    };
    const result = await approve(p.body.id);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      code: 'proposal_conflict',
      conflicts: [expect.objectContaining({ kind: 'node_changed_both', nodeId: 'a' })],
    });
    expect(updateFlow).toHaveBeenCalledTimes(1);
    expect(store.get(p.body.id).status).toBe('conflict');
  });

  it('requires a new acknowledgement when a race changes the merged result', async () => {
    const p = await submit();
    edit('b', { name: 'first live edit' });
    const ack = await approve(p.body.id);
    beforeUpdate = async () => {
      beforeUpdate = undefined;
      edit('b', { name: 'new live edit' });
    };
    const retry = await approve(p.body.id, { mergedHash: ack.body.mergedHash });
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('rebase_ack_required');
    expect(retry.body.mergedHash).not.toBe(ack.body.mergedHash);
    expect((await approve(p.body.id, { mergedHash: retry.body.mergedHash })).body.status).toBe(
      'approved'
    );
    expect(head.flows.find(n => n.id === 'b')!.name).toBe('new live edit');
  });

  it.each(['live', 'proposed'])(
    'blocks conflicts with details and resolves through the manual %s endpoint',
    async choice => {
      const p = await submit();
      edit('a', { func: 'live' });
      const blocked = await approve(p.body.id);
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({
        code: 'proposal_conflict',
        conflicts: [
          expect.objectContaining({
            kind: 'node_changed_both',
            nodeId: 'a',
            fields: ['func'],
            choices: ['live', 'proposed'],
          }),
        ],
      });
      expect(updateFlow).not.toHaveBeenCalled();
      const resolved = await request(app)
        .post(`/mcp/api/v1/proposals/${p.body.id}/resolve-conflict`)
        .send({ nodeId: 'a', choice });
      expect(resolved.status).toBe(200);
      expect(resolved.body.status).toBe('pending');
      expect((await approve(p.body.id)).body.status).toBe('approved');
      expect(head.flows.find(n => n.id === 'a')!.func).toBe(
        choice === 'live' ? 'live' : 'proposal'
      );
    }
  );

  it('AI resolves its conflicted proposal through REST with a fresh base', async () => {
    const p = await submit();
    edit('a', { func: 'live' });
    await list();
    const resolved = await request(app)
      .post(`/mcp/api/v1/proposals/${p.body.id}/resolve`)
      .set(auth())
      .send({ expectedRev: head.rev, nodes: [{ op: 'set', id: 'a', set: { func: 'resolved' } }] });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('pending');
    expect((await approve(p.body.id)).body.status).toBe('approved');
    expect(head.flows.find(n => n.id === 'a')!.func).toBe('resolved');
  });

  it('AI resolves an owned conflicted proposal using MCP resolve_proposal_conflict', async () => {
    const mcp = linkStore.create({ kind: 'mcp', label: 'MCP AI' });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await request(app)
        .post('/mcp/rpc')
        .set('Authorization', `Bearer ${mcp.token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      expect(response.status).toBe(200);
      expect(response.body.result.isError).not.toBe(true);
      return JSON.parse(response.body.result.content[0].text);
    };
    const p = await call('submit_proposal', {
      type: 'replace_flow',
      expectedRev: 'r1',
      payload: { flowId: 'tab', nodes: [{ op: 'set', id: 'a', set: { func: 'MCP proposal' } }] },
    });
    edit('a', { func: 'editor' });
    await list();
    expect(store.get(p.id).status).toBe('conflict');
    const resolved = await call('resolve_proposal_conflict', {
      id: p.id,
      expectedRev: head.rev,
      payload: { flowId: 'tab', nodes: [{ op: 'set', id: 'a', set: { func: 'MCP resolved' } }] },
    });
    expect(resolved.status).toBe('pending');
    expect((await approve(p.id)).body.status).toBe('approved');
    expect(head.flows.find(n => n.id === 'a')!.func).toBe('MCP resolved');
  });

  it('uses one immutable revision throughout submit even if the runtime moves during validation', async () => {
    const rawGetFlow = vi.fn(async () => {
      throw new Error('independent tab reads are inconsistent');
    });
    const moving = withRevHistory({
      kind: 'red',
      getFlows: async () => {
        const snapshot = clone(head);
        edit('b', { name: 'editor during submit' });
        return snapshot;
      },
      getFlow: rawGetFlow,
      updateFlow,
    });
    const p = await submitReplaceFlowProposal(
      store,
      audit,
      {
        id: 'snapshot-test',
        kind: 'rest',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      {
        type: 'replace_flow',
        expectedRev: 'r1',
        payload: { flowId: 'tab', nodes: [{ op: 'set', id: 'a', set: { func: 'proposal' } }] },
      },
      moving
    );
    expect(p.expectedRev).toBe('r1');
    expect(store.get(p.id).baseFlow!.nodes!.find(n => n.id === 'b')!.name).toBe('base');
    expect(rawGetFlow).not.toHaveBeenCalled();
    await list();
    expect(store.get(p.id)).toMatchObject({ status: 'pending', rebase: { state: 'merged' } });
  });

  it('accepts a known stale revision as the actual base and rejects an unknown revision with 409', async () => {
    await request(app).get('/mcp/api/v1/flows').set(auth());
    edit('b', { name: 'editor' });
    const p = await submit();
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({
      status: 'pending',
      expectedRev: 'r1',
      rebase: { state: 'merged', rev: head.rev },
    });
    expect(store.get(p.body.id).baseFlow!.nodes!.find(n => n.id === 'b')!.name).toBe('base');
    const bad = await submit('a', 'unknown');
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('version_mismatch');
  });

  it('returns conflict to pending when the live conflict is cleared, without rewriting unchanged checks', async () => {
    const p = await submit();
    edit('a', { func: 'live' });
    await list();
    expect(store.get(p.body.id).status).toBe('conflict');
    edit('a', { func: 'return msg;' });
    await list();
    expect(store.get(p.body.id).status).toBe('pending');
    const file = join(dir, '.ai-access', 'proposals', `${p.body.id}.json`);
    const before = readFileSync(file, 'utf8'),
      mtime = statSync(file).mtimeMs;
    await list();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  it('enforces proposalTtlDays on approval and never reopens expired or rejected records', async () => {
    const p = await submit(),
      rejected = await submit('b', 'r1', { name: 'rejected' });
    await request(app)
      .post(`/mcp/api/v1/proposals/${rejected.body.id}/reject`)
      .send({ reason: 'no' });
    const setting = await request(app).put('/mcp/api/v1/settings').send({ proposalTtlDays: 1 });
    expect(setting.status).toBe(200);
    const now = Date.now() + 2 * 86_400_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const expired = await approve(p.body.id);
    expect(expired.status).toBe(409);
    expect(store.get(p.body.id)).toMatchObject({
      status: 'expired',
      reason: expect.stringContaining('1 day'),
    });
    await list();
    expect(store.get(p.body.id).status).toBe('expired');
    expect(store.get(rejected.body.id).status).toBe('rejected');
    expect(updateFlow).not.toHaveBeenCalled();
  });

  it('debounces eager flows:started sync without a list request', async () => {
    const p = await submit();
    vi.useFakeTimers();
    edit('a', { func: 'live' });
    events.emit('flows:started');
    events.emit('flows:started');
    await vi.advanceTimersByTimeAsync(499);
    expect(store.get(p.body.id).status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(store.get(p.body.id).status).toBe('conflict');
  });

  it('protects an in-flight approve against background checks, body changes and decisions', async () => {
    const p = await submit();
    beforeUpdate = async () => {
      expect(store.isApproving(p.body.id)).toBe(true);
      const previous = store.get(p.body.id);
      const staleLive = clone(head);
      staleLive.rev = 'old-check';
      staleLive.flows.find(n => n.id === 'a')!.func = 'conflicting stale read';
      syncOneProposal(store, previous, staleLive);
      await syncOpenProposals(store, adapter, { live: staleLive });
      expect(store.get(p.body.id).rebase).toEqual(previous.rebase);
      expect(() =>
        store.updateBody(p.body.id, { baseFlow: previous.baseFlow!, flow: previous.payload.flow })
      ).toThrow(expect.objectContaining({ code: 'proposal_approve_in_progress' }));
      expect(() => store.markRejected(p.body.id, { kind: 'admin' }, 'no')).toThrow(
        expect.objectContaining({ code: 'proposal_approve_in_progress' })
      );
      expect(() => store.markWithdrawn(p.body.id, { kind: 'admin' }, 'no')).toThrow(
        expect.objectContaining({ code: 'proposal_approve_in_progress' })
      );
    };
    const service = new ProposalService(store, audit, adapter, () => 'nodes');
    expect((await service.approve(p.body.id, { kind: 'admin' })).status).toBe('approved');
    expect(store.isApproving(p.body.id)).toBe(false);
  });

  it('restores secrets and keeps warning metadata and restoration audit on AI resolution', async () => {
    edit('a', { func: 'const API_KEY = "original-secret";\nreturn msg;' });
    const rev = head.rev;
    const p = await submit('a', rev, { name: 'proposal' });
    expect(p.status).toBe(201);
    const stored = store.get(p.body.id);
    expect(stored.restoredSecrets).toContainEqual({ nodeId: 'a', property: 'func' });
    const resolved = await request(app)
      .post(`/mcp/api/v1/proposals/${p.body.id}/resolve`)
      .set(auth())
      .send({
        expectedRev: rev,
        nodes: [
          {
            op: 'set',
            id: 'a',
            set: { func: '// AI change\nconst API_KEY = "[REDACTED]";\nreturn msg;' },
          },
        ],
      });
    expect(resolved.status).toBe(200);
    expect(resolved.body.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'secret_node_code_changed' })])
    );
    expect(store.get(p.body.id).restoredSecrets).toEqual(stored.restoredSecrets);
    expect(audit.list(100).find(e => e.action === 'proposal.resolved')!.details).toMatchObject({
      restoredRedactions: 1,
    });
    expect((await approve(p.body.id)).body.status).toBe('approved');
    expect(JSON.stringify(head.flows)).not.toContain('[REDACTED]');
    expect(head.flows.find(n => n.id === 'a')!.func).toContain('original-secret');
  });

  it('adapterAtRev preserves raw and redacted history views', async () => {
    edit('a', { func: 'const API_KEY = "history-secret";\nreturn msg;' });
    const rev = head.rev;
    await adapter.getFlows();
    edit('a', { func: 'const API_KEY = "live-secret";\nreturn msg;' });
    const raw = await adapterAtRev(adapter, rev),
      redacted = await adapterAtRev(aiRedactingAdapter(adapter), rev);
    expect(JSON.stringify((await raw.getFlows()).flows)).toContain('history-secret');
    expect(JSON.stringify((await redacted.getFlows()).flows)).toContain('[REDACTED]');
    expect(JSON.stringify((await redacted.getFlows()).flows)).not.toContain('history-secret');
    expect(await adapterAtRev(adapter, 'unknown')).toBe(adapter);
  });

  it('clears tab properties removed by a proposal, including secret env values', async () => {
    edit('tab', {
      disabled: true,
      info: 'old info',
      env: [{ name: 'API_KEY', value: 'remove-this-secret', type: 'str' }],
    });
    const flow = (await adapter.getFlow('tab')).flow;
    delete flow.label;
    delete flow.disabled;
    delete flow.info;
    delete flow.env;
    const submitted = await request(app)
      .post('/mcp/api/v1/proposals')
      .set(auth())
      .send({
        type: 'replace_flow',
        expectedRev: head.rev,
        payload: { flowId: 'tab', flow },
      });
    expect(submitted.status).toBe(201);
    expect((await approve(submitted.body.id)).body.status).toBe('approved');
    expect(head.flows.find(n => n.id === 'tab')).toMatchObject({
      label: '',
      disabled: false,
      info: '',
      env: [],
    });
    expect(JSON.stringify(head.flows)).not.toContain('remove-this-secret');
  });
});
