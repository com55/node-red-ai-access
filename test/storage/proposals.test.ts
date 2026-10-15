/**
 * Proposal store + service lifecycle tests (temp directory).
 */

import { mkdtempSync, rmSync } from 'node:fs';
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
      getFlows: () => Promise.resolve({ rev: 'rev-1', flows: [] }),
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
      createdBy: { kind: 'access-link', linkId: 'link-1', label: 'bot' },
    });
  }

  it('persists proposals as JSON and lists them', () => {
    const created = createPending();
    expect(store.get(created.id).status).toBe('pending');
    expect(store.list()).toHaveLength(1);
    expect(store.list({ linkId: 'other' })).toHaveLength(0);
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

  it('rev conflict marks proposal rejected with resubmit reason', async () => {
    const created = createPending();
    updateFlow.mockRejectedValueOnce(new FlowRevisionConflictError('rev-1', 'rev-9', 'updateFlow'));
    const result = await service.approve(created.id, { kind: 'admin', username: 'admin' });
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/resubmit/i);
    expect(updateFlow).toHaveBeenCalledOnce();
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
    await Promise.resolve();
    await expect(
      service.approve(created.id, { kind: 'admin', username: 'b' })
    ).rejects.toBeInstanceOf(ProposalConcurrentApproveError);
    release();
    await expect(first).resolves.toMatchObject({ status: 'approved' });
  });
});
