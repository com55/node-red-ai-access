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
      `Flow revision conflict in ${context}: expected_rev '${expectedRev}' does not match current rev '${currentRev}'. The flows changed since you last read them — re-read flows, re-apply your change, and retry.`
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

  constructor(message: string) {
    super(message);
    this.name = 'AdapterUnavailableError';
  }
}
