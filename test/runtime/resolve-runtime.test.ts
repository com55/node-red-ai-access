/**
 * resolveRuntimeHost — prefer RED.runtime; else initialized @node-red/runtime.
 */

import { describe, expect, it } from 'vitest';

import { canUseRedRuntime } from '../../src/runtime/red-adapter.js';
import { hasInProcessFlowsApi, resolveRuntimeHost } from '../../src/runtime/resolve-runtime.js';
import type { RedRuntimeHost } from '../../src/runtime/types.js';

describe('resolveRuntimeHost', () => {
  it('returns RED when runtime.flows methods are present', () => {
    const RED: RedRuntimeHost = {
      runtime: {
        flows: {
          getFlows: () => Promise.resolve({ rev: '1', flows: [] }),
          getFlow: () => Promise.resolve({ id: 't', type: 'tab', nodes: [] }),
          setFlows: () => Promise.resolve({ rev: '2' }),
        },
      },
    };
    const resolved = resolveRuntimeHost(RED);
    expect(resolved).toBe(RED);
    expect(canUseRedRuntime(resolved)).toBe(true);
    expect(hasInProcessFlowsApi(RED)).toBe(true);
  });

  it('does not use uninitialized @node-red/runtime from node_modules alone', () => {
    // node-red is a devDependency; requiring the package must not select RedAdapter
    // until the host process has actually init'd the runtime (plugin load).
    const resolved = resolveRuntimeHost({});
    expect(resolved).toBeNull();
    expect(hasInProcessFlowsApi(null)).toBe(false);
  });

  it('returns null for incomplete RED.runtime without falling through silently', () => {
    const incomplete: RedRuntimeHost = {
      runtime: {
        flows: {
          getFlows: () => Promise.resolve({ rev: '1', flows: [] }),
          // getFlow / setFlows missing
        },
      },
    };
    expect(resolveRuntimeHost(incomplete)).toBeNull();
  });
});
