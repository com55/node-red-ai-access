/**
 * Prefer in-process RED.runtime; fall back to the localhost Admin API.
 */

import { AdapterUnavailableError } from './errors.js';
import { HttpAdapter } from './http-adapter.js';
import { canUseRedRuntime, RedAdapter } from './red-adapter.js';
import type { FlowAdapter, HttpAdapterOptions, RedRuntimeHost } from './types.js';

export interface CreateFlowAdapterOptions {
  /** Node-RED runtime host (plugin `RED` object). */
  RED?: RedRuntimeHost | null;
  /** Localhost Admin API options used when runtime methods are missing. */
  http?: HttpAdapterOptions;
}

/**
 * Pick RedAdapter when `RED.runtime.flows` exposes getFlows/getFlow/setFlows;
 * otherwise use HttpAdapter when `http` is configured.
 */
export function createFlowAdapter(options: CreateFlowAdapterOptions = {}): FlowAdapter {
  const red = options.RED ?? undefined;
  if (red && canUseRedRuntime(red)) {
    return new RedAdapter(red);
  }

  if (options.http?.baseUrl) {
    return new HttpAdapter(options.http);
  }

  throw new AdapterUnavailableError(
    'No usable Node-RED flow adapter: RED.runtime.flows is incomplete and no HTTP Admin API baseUrl was provided'
  );
}
