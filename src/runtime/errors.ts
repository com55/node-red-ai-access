/**
 * Typed errors for the flow adapter layer.
 */

export class FlowRevisionConflictError extends Error {
  readonly code = 'version_mismatch' as const;
  readonly statusCode = 409;
  readonly expectedRev: string;
  readonly currentRev: string;
  readonly context: string;

  constructor(expectedRev: string, currentRev: string, context = 'updateFlow') {
    super(
      `Flow revision conflict in ${context}: expectedRev '${expectedRev}' does not match current rev '${currentRev}'. The flows changed since you last read them — re-read flows, re-apply your change, and retry.`
    );
    this.name = 'FlowRevisionConflictError';
    this.expectedRev = expectedRev;
    this.currentRev = currentRev;
    this.context = context;
  }
}

export class FlowNotFoundError extends Error {
  readonly code = 'flow_not_found' as const;
  readonly statusCode = 404;
  readonly flowId: string;

  constructor(flowId: string) {
    super(`Flow '${flowId}' was not found`);
    this.name = 'FlowNotFoundError';
    this.flowId = flowId;
  }
}

export class AdapterUnavailableError extends Error {
  readonly code = 'adapter_unavailable' as const;
  readonly statusCode = 502;

  constructor(message: string) {
    super(message);
    this.name = 'AdapterUnavailableError';
  }
}

/**
 * HTTP Admin API fallback was selected or used incorrectly (typically missing
 * credentials while adminAuth is enabled). Tell the AI to alert the admin.
 */
export class PluginMisconfiguredError extends Error {
  readonly code = 'plugin_misconfigured' as const;
  readonly statusCode = 502;

  constructor(message: string) {
    super(message);
    this.name = 'PluginMisconfiguredError';
  }
}

export const PLUGIN_MISCONFIGURED_HTTP_AUTH_MESSAGE =
  'Node-RED AI Access could not use the in-process flow runtime and the HTTP Admin API fallback returned Unauthorized. The plugin is misconfigured — tell the admin to ensure the plugin loads inside Node-RED so RED.runtime.flows is available (do not rely on unauthenticated localhost HTTP when adminAuth is enabled).';
