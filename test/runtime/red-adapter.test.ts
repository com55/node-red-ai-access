/**
 * Unit tests for RedAdapter (in-process RED.runtime.flows).
 */

import { describe, expect, it, vi } from 'vitest';

import { FlowRevisionConflictError } from '../../src/runtime/errors.js';
import { canUseRedRuntime, RedAdapter } from '../../src/runtime/red-adapter.js';
import type { FlowNode, FlowsSnapshot, RedRuntimeHost } from '../../src/runtime/types.js';

function sampleFlows(rev = 'rev-1'): FlowsSnapshot {
  return {
    rev,
    flows: [
      { id: 'tab-1', type: 'tab', label: 'Main' },
      { id: 'n1', type: 'inject', z: 'tab-1', name: 'kick' },
      { id: 'tab-2', type: 'tab', label: 'Other' },
    ],
  };
}

function createMockRed(overrides?: {
  getFlows?: () => Promise<FlowsSnapshot>;
  getFlow?: (opts: { id: string }) => Promise<unknown>;
  setFlows?: (opts: unknown) => Promise<unknown>;
}): { RED: RedRuntimeHost; setFlows: ReturnType<typeof vi.fn> } {
  const setFlows = vi.fn(
    overrides?.setFlows ??
      (() =>
        Promise.resolve({
          rev: 'rev-2',
          flows: sampleFlows('rev-2').flows,
        }))
  );

  const RED: RedRuntimeHost = {
    runtime: {
      flows: {
        getFlows: overrides?.getFlows ?? (() => Promise.resolve(sampleFlows())),
        getFlow:
          overrides?.getFlow ??
          (({ id }) => {
            if (id !== 'tab-1') {
              return Promise.reject(Object.assign(new Error('not found'), { status: 404 }));
            }
            return Promise.resolve({
              id: 'tab-1',
              type: 'tab',
              label: 'Main',
              nodes: [{ id: 'n1', type: 'inject', z: 'tab-1', name: 'kick' }],
            });
          }),
        setFlows,
      },
    },
  };

  return { RED, setFlows };
}

describe('canUseRedRuntime', () => {
  it('is true when getFlows, getFlow, and setFlows exist', () => {
    const { RED } = createMockRed();
    expect(canUseRedRuntime(RED)).toBe(true);
  });

  it('is false when a required method is missing', () => {
    expect(
      canUseRedRuntime({
        runtime: { flows: { getFlows: () => Promise.resolve(sampleFlows()) } },
      })
    ).toBe(false);
    expect(canUseRedRuntime({})).toBe(false);
    expect(canUseRedRuntime(null)).toBe(false);
  });
});

describe('RedAdapter', () => {
  it('getFlows returns rev and flows from RED.runtime', async () => {
    const { RED } = createMockRed();
    const adapter = new RedAdapter(RED);
    await expect(adapter.getFlows()).resolves.toEqual(sampleFlows());
    expect(adapter.kind).toBe('red');
  });

  it('getFlow returns nested tab content plus current rev', async () => {
    const { RED } = createMockRed();
    const adapter = new RedAdapter(RED);
    const result = await adapter.getFlow('tab-1');
    expect(result.rev).toBe('rev-1');
    expect(result.flow.id).toBe('tab-1');
    expect(result.flow.nodes).toEqual([expect.objectContaining({ id: 'n1', type: 'inject' })]);
  });

  it('updateFlow defaults deploymentType to nodes and posts merged flows', async () => {
    const { RED, setFlows } = createMockRed();
    const adapter = new RedAdapter(RED);

    const result = await adapter.updateFlow({
      flowId: 'tab-1',
      expectedRev: 'rev-1',
      flow: {
        label: 'Main',
        nodes: [{ id: 'n2', type: 'debug', name: 'out' }],
      },
    });

    expect(result).toEqual({ flowId: 'tab-1', rev: 'rev-2' });
    expect(setFlows).toHaveBeenCalledOnce();
    const arg = setFlows.mock.calls[0]?.[0] as {
      deploymentType: string;
      flows: FlowNode[];
    };
    expect(arg.deploymentType).toBe('nodes');
    expect(arg.flows.find(n => n.id === 'tab-1')).toMatchObject({ label: 'Main' });
    expect(arg.flows.find(n => n.id === 'n2')).toMatchObject({ type: 'debug', z: 'tab-1' });
    expect(arg.flows.find(n => n.id === 'n1')).toBeUndefined();
    expect(arg.flows.find(n => n.id === 'tab-2')).toBeDefined();
  });

  it('updateFlow forwards deploymentType flows|full', async () => {
    const { RED, setFlows } = createMockRed();
    const adapter = new RedAdapter(RED);

    await adapter.updateFlow({
      flowId: 'tab-1',
      expectedRev: 'rev-1',
      deploymentType: 'full',
      flow: { nodes: [{ id: 'n1', type: 'inject' }] },
    });

    expect(setFlows.mock.calls[0]?.[0]).toMatchObject({ deploymentType: 'full' });
  });

  it('updateFlow throws FlowRevisionConflictError when expectedRev is stale', async () => {
    const { RED, setFlows } = createMockRed();
    const adapter = new RedAdapter(RED);

    await expect(
      adapter.updateFlow({
        flowId: 'tab-1',
        expectedRev: 'stale-rev',
        flow: { nodes: [] },
      })
    ).rejects.toBeInstanceOf(FlowRevisionConflictError);

    await expect(
      adapter.updateFlow({
        flowId: 'tab-1',
        expectedRev: 'stale-rev',
        flow: { nodes: [] },
      })
    ).rejects.toMatchObject({
      code: 'version_mismatch',
      statusCode: 409,
      expectedRev: 'stale-rev',
      currentRev: 'rev-1',
    });

    expect(setFlows).not.toHaveBeenCalled();
  });
});
