/**
 * In-process adapter over RED.runtime.flows.
 */

import { FlowRevisionConflictError } from './errors.js';
import { assertFlowsSnapshot, normalizeFlowTab, replaceFlowTabInFlatFlows } from './flows-util.js';
import type {
  DeploymentType,
  FlowAdapter,
  FlowSnapshot,
  FlowsSnapshot,
  RedRuntimeFlows,
  RedRuntimeHost,
  UpdateFlowParams,
  UpdateFlowResult,
} from './types.js';

function requireFlowsApi(RED: RedRuntimeHost): RedRuntimeFlows {
  const flows = RED.runtime?.flows;
  if (!flows?.getFlows || !flows.getFlow || !flows.setFlows) {
    throw new Error('RED.runtime.flows is missing getFlows, getFlow, or setFlows');
  }
  return flows as RedRuntimeFlows;
}

function resolveRev(result: FlowsSnapshot | { rev: string } | string): string {
  if (typeof result === 'string') {
    return result;
  }
  if (typeof result.rev === 'string' && result.rev.length > 0) {
    return result.rev;
  }
  throw new Error('RED.runtime.flows.setFlows did not return a rev');
}

export class RedAdapter implements FlowAdapter {
  readonly kind = 'red' as const;
  private readonly flows: RedRuntimeFlows;

  constructor(RED: RedRuntimeHost) {
    this.flows = requireFlowsApi(RED);
  }

  async getFlows(): Promise<FlowsSnapshot> {
    const result = await this.flows.getFlows({});
    return assertFlowsSnapshot(result, 'RED.runtime.flows.getFlows()');
  }

  async getFlow(flowId: string): Promise<FlowSnapshot> {
    const [snapshot, raw] = await Promise.all([
      this.getFlows(),
      this.flows.getFlow({ id: flowId }),
    ]);
    return {
      rev: snapshot.rev,
      flow: normalizeFlowTab(flowId, raw),
    };
  }

  async updateFlow(params: UpdateFlowParams): Promise<UpdateFlowResult> {
    const deploymentType: DeploymentType = params.deploymentType ?? 'nodes';
    const current = await this.getFlows();

    if (current.rev !== params.expectedRev) {
      throw new FlowRevisionConflictError(params.expectedRev, current.rev, 'updateFlow');
    }

    const merged = replaceFlowTabInFlatFlows(current.flows, params.flowId, params.flow);
    // Node-RED runtime API expects opts.flows = { flows: [...], rev?, credentials? }
    // (not a bare array). Passing the array made setFlows call forEach on undefined.
    const result = await this.flows.setFlows({
      flows: {
        flows: merged,
        rev: params.expectedRev,
      },
      deploymentType,
    });

    return {
      flowId: params.flowId,
      rev: resolveRev(result),
    };
  }
}

/** True when RED.runtime exposes the methods RedAdapter needs. */
export function canUseRedRuntime(RED: RedRuntimeHost | null | undefined): boolean {
  const flows = RED?.runtime?.flows;
  return Boolean(flows?.getFlows && flows.getFlow && flows.setFlows);
}
