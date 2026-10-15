/**
 * Resolve the Node-RED flows API for in-process use.
 *
 * Plugin modules receive a RED object from `createNodeApi` that does **not**
 * include `RED.runtime`. The process-wide `@node-red/runtime` singleton (already
 * loaded and initialized by Node-RED) exposes `flows.getFlows` / `getFlow` /
 * `setFlows`. We only use that singleton when settings are available (runtime
 * has been `init`'d) so unit tests that merely have `node-red` installed do not
 * silently pick an unusable RedAdapter.
 */

import { createRequire } from 'node:module';

import type { RedRuntimeFlows, RedRuntimeHost } from './types.js';

function isFlowsApi(value: unknown): value is RedRuntimeFlows {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const flows = value as Partial<RedRuntimeFlows>;
  return (
    typeof flows.getFlows === 'function' &&
    typeof flows.getFlow === 'function' &&
    typeof flows.setFlows === 'function'
  );
}

function createPluginRequire(): NodeRequire {
  // Prefer free `require` in the CJS plugin build; Vitest/ESM uses createRequire.
  if (typeof require === 'function') {
    return require;
  }
  const metaUrl = (0, eval)('import.meta.url') as string;
  return createRequire(metaUrl);
}

/** True when Node-RED has initialized `@node-red/runtime` in this process. */
function isNodeRedRuntimeInitialized(req: NodeRequire): boolean {
  try {
    const settings = req('@node-red/runtime/lib/settings') as { available?: () => boolean };
    return typeof settings.available === 'function' && settings.available() === true;
  } catch {
    return false;
  }
}

function tryRequireInitializedRuntimeFlows(): RedRuntimeFlows | null {
  try {
    const req = createPluginRequire();
    if (!isNodeRedRuntimeInitialized(req)) {
      return null;
    }
    const mod = req('@node-red/runtime') as { flows?: unknown };
    if (isFlowsApi(mod.flows)) {
      return mod.flows;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Prefer `RED.runtime` when present; otherwise use the initialized
 * `@node-red/runtime` singleton (real plugin load inside Node-RED).
 */
export function resolveRuntimeHost(RED?: RedRuntimeHost | null): RedRuntimeHost | null {
  if (RED?.runtime && isFlowsApi(RED.runtime.flows)) {
    return RED;
  }

  const flows = tryRequireInitializedRuntimeFlows();
  if (flows) {
    return { runtime: { flows } };
  }

  return null;
}

export function hasInProcessFlowsApi(RED?: RedRuntimeHost | null): boolean {
  return resolveRuntimeHost(RED) !== null;
}
