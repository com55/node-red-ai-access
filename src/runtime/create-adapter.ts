/**
 * Prefer in-process flows API; fall back to HTTP only when safe.
 */

import { AdapterUnavailableError } from './errors.js';
import { HttpAdapter } from './http-adapter.js';
import { canUseRedRuntime, RedAdapter } from './red-adapter.js';
import { resolveRuntimeHost } from './resolve-runtime.js';
import type { FlowAdapter, HttpAdapterOptions, RedRuntimeHost } from './types.js';

export interface CreateFlowAdapterOptions {
  /** Node-RED runtime host (plugin `RED` object, or resolved runtime). */
  RED?: RedRuntimeHost | null;
  /** Localhost Admin API options used when runtime methods are missing. */
  http?: HttpAdapterOptions;
  /**
   * When true, refuse unauthenticated HTTP fallback (adminAuth is on).
   * Defaults to false for unit tests that intentionally use HTTP without auth.
   */
  adminAuthEnabled?: boolean;
}

/**
 * Pick RedAdapter when an in-process flows API is available (on `RED.runtime`
 * or via `@node-red/runtime`). Otherwise use HttpAdapter only when it can
 * succeed (credentials present, or adminAuth off).
 */
export function createFlowAdapter(options: CreateFlowAdapterOptions = {}): FlowAdapter {
  const resolved = resolveRuntimeHost(options.RED ?? null);
  if (resolved && canUseRedRuntime(resolved)) {
    return new RedAdapter(resolved);
  }

  const adminAuthEnabled = options.adminAuthEnabled === true;
  if (options.http?.baseUrl) {
    if (adminAuthEnabled && !options.http.accessToken) {
      throw new AdapterUnavailableError(
        'In-process Node-RED flow runtime is unavailable and HTTP Admin API fallback has no credentials while adminAuth is enabled. Ensure the plugin runs inside Node-RED so @node-red/runtime.flows can be used.'
      );
    }
    return new HttpAdapter(options.http);
  }

  throw new AdapterUnavailableError(
    'No usable Node-RED flow adapter: in-process flows API is unavailable and no HTTP Admin API baseUrl was provided'
  );
}
