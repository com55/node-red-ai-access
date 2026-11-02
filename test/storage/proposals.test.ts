/**
 * Proposal store + service lifecycle tests (temp directory).
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProposalService } from '../../src/plugin/proposal-service.js';
import { FlowRevisionConflictError } from '../../src/runtime/errors.js';
import type { FlowAdapter, UpdateFlowParams } from '../../src/runtime/types.js';
import { AuditLog } from '../../src/storage/audit-log.js';
import { ensureAiAccessDirs, resolveAiAccessPaths } from '../../src/storage/paths.js';
import { ProposalConcurrentApproveError, ProposalStore } from '../../src/storage/proposals.js';

describe('ProposalStore + ProposalService', () => {
  let root: string;
  let store: ProposalStore;
  let audit: AuditLog;
  let updateFlow: ReturnType<
    typeof vi.fn<(params: UpdateFlowParams) => Promise<{ flowId: string; rev: string }>>
  >;
  let adapter: FlowAdapter;
  let service: ProposalService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ai-access-'));
    const paths = resolveAiAccessPaths(root);
    ensureAiAccessDirs(paths);
    store = new ProposalStore(paths, { randomId: () => 'abc' });
    audit = new AuditLog(paths);
    updateFlow = vi.fn(() => Promise.resolve({ flowId: 'tab-1', rev: 'rev-2' }));
    adapter = {
      kind: 'red',
      getFlows: () =>
        Promise.resolve({
          rev: 'rev-1',
          flows: [
            { id: 'tab-1', type: 'tab', label: 'Old' },
            { id: 'n1', type: 'inject', z: 'tab-1' },
          ],
        }),
      getFlow: () =>
        Promise.resolve({ rev: 'rev-1', flow: { id: 'tab-1', type: 'tab', nodes: [] } }),
      updateFlow,
    };
    service = new ProposalService(store, audit, adapter, () => 'nodes');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function createPending() {
    return store.create({
      type: 'replace_flow',
      expectedRev: 'rev-1',
      payload: {
        flowId: 'tab-1',
        flow: { label: 'Main', nodes: [{ id: 'n1', type: 'inject' }] },
      },
      baseFlow: { id: 'tab-1', type: 'tab', label: 'Old', nodes: [{ id: 'n1', type: 'inject' }] },
      title: 'Edit n1 (inject)',
      createdBy: { kind: 'access-link', linkId: 'link-1', label: 'bot' },
    });
  }

  it.each(['withdrawn', 'rejected', 'expired'] as const)(
    'clears unknown deploy blocks when %s',
    status => {
      const p = createPending();
      store.recordDeployPending(p.id, {
        mergedHash: 'a'.repeat(64),
        reason: 'Unknown',
        queueReleased: true,
      });
      if (status === 'withdrawn') store.markWithdrawn(p.id, { kind: 'admin' }, 'Stop');
      else if (status === 'rejected') store.markRejected(p.id, { kind: 'admin' }, 'Stop');
      else store.markClosed(p.id, 'expired', 'TTL');
      expect(store.get(p.id).deployPending).toBeUndefined();
    }
  );

  it.each([undefined, 'previous-boot'])('ignores unknown deploy flags from boot %s', bootId => {
    const p = createPending();
    store.recordDeployPending(p.id, {
      mergedHash: 'a'.repeat(64),
      reason: 'Unknown',
      queueReleased: true,
    });
    const file = join(resolveAiAccessPaths(root).proposals, p.id + '.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.deployPending.bootId = bootId;
    writeFileSync(file, JSON.stringify(raw));
    expect(new ProposalStore(resolveAiAccessPaths(root)).get(p.id).deployPending).toBeUndefined();
  });

  it('beginApprove preserves the pending attempt token on retry', () => {
    const p = createPending();
    store.recordDeployPending(p.id, {
      mergedHash: 'abc12345',
      attemptId: 'original',
      reason: 'Unknown',
    });
    expect(store.beginApprove(p.id).deployPending?.attemptId).toBe('original');
    expect(store.get(p.id).deployPending?.attemptId).toBe('original');
    store.releaseLock(p.id);
  });

  it('persists proposals as JSON and lists them', () => {
    const created = createPending();
    expect(store.get(created.id).status).toBe('pending');
    expect(store.get(created.id).baseFlow).toMatchObject({ label: 'Old' });
    expect(store.list()).toHaveLength(1);
    expect(store.list({ linkId: 'other' })).toHaveLength(0);
    expect(store.list({ status: 'pending' })).toHaveLength(1);
    expect(store.list({ status: 'approved' })).toHaveLength(0);
    expect(store.list({ flowId: 'tab-1' })).toHaveLength(1);
    expect(store.list({ flowId: 'other-tab' })).toHaveLength(0);
  });

  it('keeps acknowledgement on body replacement until each overridden field matches base', () => {
    const created = createPending();
    const baseFlow = {
      id: 'tab-1',
      env: [{ name: 'MODE', value: 'live' }],
      nodes: [{ id: 'n1', type: 'inject', credentials: { token: 'live' }, name: 'live' }],
      configs: [{ id: 'cfg', type: 'config', name: 'live' }],
    };
    const flow = {
      ...baseFlow,
      env: [{ name: 'MODE', value: 'AI' }],
      nodes: [{ id: 'n1', type: 'inject', credentials: { token: 'AI' }, name: 'AI' }],
      configs: [{ id: 'cfg', type: 'config', name: 'AI' }],
    };
    const overrides = [
      { nodeId: 'tab-1', fields: ['env["MODE"].value'] },
      { nodeId: 'n1', fields: ['credentials.token', 'name'] },
      { nodeId: 'cfg', fields: [''] },
    ];
    store.updateBody(created.id, { baseFlow, flow, aiConflictOverrides: overrides });
    expect(store.updateBody(created.id, { baseFlow, flow }).aiConflictOverrides).toEqual(overrides);

    flow.nodes[0]!.credentials.token = 'live';
    expect(store.updateBody(created.id, { baseFlow, flow }).aiConflictOverrides).toEqual([
      overrides[0],
      { nodeId: 'n1', fields: ['name'] },
      overrides[2],
    ]);
    expect(
      store.updateBody(created.id, { baseFlow, flow: baseFlow }).aiConflictOverrides
    ).toBeUndefined();
  });

  it('allows explicit override restoration or clearing for conflict choices and undo', () => {
    const created = createPending();
    const update = { baseFlow: created.baseFlow!, flow: created.payload.flow };
    store.updateBody(created.id, {
      ...update,
      aiConflictOverrides: [{ nodeId: 'tab-1', fields: ['label'] }],
    });
    expect(
      store.updateBody(created.id, { ...update, aiConflictOverrides: [] }).aiConflictOverrides
    ).toBeUndefined();
  });

  it('approve calls the adapter and marks approved with audit', async () => {
    const created = createPending();
    const approved = await service.approve(created.id, { kind: 'admin', username: 'admin' });
    expect(approved.status).toBe('approved');
    expect(approved.resultRev).toBe('rev-2');
    expect(updateFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'tab-1',
        expectedRev: 'rev-1',
        deploymentType: 'nodes',
      })
    );
    expect(audit.list()[0]?.action).toBe('proposal.approved');
  });

  it('rev race retries and approves without closing the proposal', async () => {
    const created = createPending();
    updateFlow.mockRejectedValueOnce(new FlowRevisionConflictError('rev-1', 'rev-9', 'updateFlow'));
    const result = await service.approve(created.id, { kind: 'admin', username: 'admin' });
    expect(result.status).toBe('approved');
    expect(result.reason).toBeUndefined();
    expect(updateFlow).toHaveBeenCalledTimes(2);
  });

  it('other deploy errors mark proposal failed', async () => {
    const created = createPending();
    updateFlow.mockRejectedValueOnce(new Error('boom'));
    const result = await service.approve(created.id, { kind: 'admin' });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('boom');
  });

  it('reject does not call the adapter', () => {
    const created = createPending();
    const rejected = service.reject(created.id, { kind: 'admin', username: 'admin' }, 'nope');
    expect(rejected.status).toBe('rejected');
    expect(rejected.reason).toBe('nope');
    expect(updateFlow).not.toHaveBeenCalled();
  });

  it('rejects path-traversal proposal ids', () => {
    expect(() => store.get('../etc/passwd')).toThrow();
    expect(() => store.get('prop-../../x')).toThrow();
  });

  it('guards concurrent approve of the same proposal', async () => {
    const created = createPending();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    updateFlow.mockImplementationOnce(async () => {
      await gate;
      return { flowId: 'tab-1', rev: 'rev-2' };
    });

    const first = service.approve(created.id, { kind: 'admin', username: 'a' });
    await vi.waitFor(() => expect(updateFlow).toHaveBeenCalledTimes(1));
    await expect(
      service.approve(created.id, { kind: 'admin', username: 'b' })
    ).rejects.toBeInstanceOf(ProposalConcurrentApproveError);
    release();
    await expect(first).resolves.toMatchObject({ status: 'approved' });
  });
});
