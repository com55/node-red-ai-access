/**
 * Flow adapter contracts for in-process RED.runtime and Admin API fallback.
 */

/** Admin API / runtime deployment types used when applying an update. */
export type DeploymentType = 'nodes' | 'flows' | 'full';

/** One node (or tab) object from the flat Admin API v2 flows array. */
export type FlowNode = Record<string, unknown> & {
  id: string;
  type: string;
  z?: string;
};

/**
 * Nested tab shape used by GET /flow/:id and by updateFlow payloads.
 * Child nodes live in `nodes` / `configs` (not in the flat array form).
 */
export interface FlowTab {
  id: string;
  type?: string;
  label?: string;
  disabled?: boolean;
  info?: string;
  env?: unknown[];
  nodes?: FlowNode[];
  configs?: FlowNode[];
  [key: string]: unknown;
}

export interface FlowsSnapshot {
  rev: string;
  flows: FlowNode[];
}

export interface FlowSnapshot {
  rev: string;
  flow: FlowTab;
}

export interface UpdateFlowParams {
  flowId: string;
  /** Replacement tab content (label/disabled/info/env + nodes/configs). */
  flow: Partial<FlowTab>;
  /** Revision from a prior getFlows/getFlow — must match the live rev. */
  expectedRev: string;
  /** Defaults to `nodes` (modified-nodes deploy). */
  deploymentType?: DeploymentType;
}

export interface UpdateFlowResult {
  flowId: string;
  rev: string;
}

export interface FlowAdapter {
  readonly kind: 'red' | 'http';
  getFlows(): Promise<FlowsSnapshot>;
  getFlow(flowId: string): Promise<FlowSnapshot>;
  updateFlow(params: UpdateFlowParams): Promise<UpdateFlowResult>;
}

/** Minimal RED.runtime.flows surface required by RedAdapter. */
export interface RedRuntimeFlows {
  getFlows: (opts?: Record<string, unknown>) => Promise<FlowsSnapshot>;
  getFlow: (opts: { id: string } & Record<string, unknown>) => Promise<FlowTab | FlowNode[]>;
  setFlows: (
    opts: {
      /**
       * Config object `{ flows: [...], rev?, credentials? }` as required by
       * `@node-red/runtime` `flows.setFlows` (not a bare array).
       */
      flows: { flows: FlowNode[]; rev?: string; credentials?: unknown };
      deploymentType?: DeploymentType;
    } & Record<string, unknown>
  ) => Promise<FlowsSnapshot | { rev: string } | string>;
}

export interface RedRuntimeHost {
  runtime?: {
    flows?: Partial<RedRuntimeFlows>;
  };
}

export interface HttpAdapterOptions {
  /** Base URL of the Node-RED Admin HTTP API (e.g. http://127.0.0.1:1880). */
  baseUrl: string;
  /** Optional Bearer token when adminAuth is enabled. */
  accessToken?: string;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}
