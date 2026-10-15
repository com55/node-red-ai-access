/**
 * Public exports for the Node-RED flow runtime adapter layer.
 */

export { createFlowAdapter } from './create-adapter.js';
export type { CreateFlowAdapterOptions } from './create-adapter.js';
export {
  AdapterUnavailableError,
  FlowNotFoundError,
  FlowRevisionConflictError,
  PluginMisconfiguredError,
  PLUGIN_MISCONFIGURED_HTTP_AUTH_MESSAGE,
} from './errors.js';
export { replaceFlowTabInFlatFlows } from './flows-util.js';
export { HttpAdapter } from './http-adapter.js';
export { canUseRedRuntime, RedAdapter } from './red-adapter.js';
export { hasInProcessFlowsApi, resolveRuntimeHost } from './resolve-runtime.js';
export type {
  DeploymentType,
  FlowAdapter,
  FlowNode,
  FlowSnapshot,
  FlowsSnapshot,
  FlowTab,
  HttpAdapterOptions,
  RedRuntimeFlows,
  RedRuntimeHost,
  UpdateFlowParams,
  UpdateFlowResult,
} from './types.js';
