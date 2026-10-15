/**
 * Per-tool execution helpers for McpNodeRedServer.callTool.
 * Extracted to keep callTool under max-lines / complexity limits.
 */

import { NodeErrorChecker } from '../services/node-error-checker.js';
import type { NodeRedAPIClient, NodeRedModule } from '../services/nodered-api.js';
import type { SemanticFlowIndex } from '../services/semantic-index.js';
import type { McpToolResult } from '../types/mcp-extensions.js';
import type { NodeRedFlow, NodeRedFlowStatus, NodeRedNode } from '../types/nodered.js';
import { validateRequired } from '../utils/error-handling.js';

import {
  FLOW_SORT_KEYS,
  type FlowSortKey,
} from './mcp-tool-definitions.js';
import {
  applyPagination,
  caseInsensitiveIncludes,
  isPaginated,
  parsePagination,
  parseSort,
  stableSortBy,
} from './pagination.js';

export type ToolArgs = Record<string, unknown>;

export interface TextToolContent {
  type: 'text';
  text: string;
}
export interface CallToolResponse {
  /** Index signature keeps this assignable to MCP SDK CallToolResult. */
  [key: string]: unknown;
  content: TextToolContent[];
}

export type ToolOutcome =
  | { kind: 'result'; result: McpToolResult }
  | { kind: 'content'; response: CallToolResponse };

interface FlowSortable {
  id?: string;
  label?: string;
  disabled?: boolean;
  nodeCount?: number;
  nodes?: unknown[];
}

type ModuleCategory = 'all' | 'contrib' | 'dashboard';
type SemanticScope = 'flows' | 'nodes' | 'all';

export interface FlowSearchMatch {
  nodeId: string;
  nodeType: string;
  nodeName: string;
  flowId: string;
  flowLabel: string;
}

export interface FlowValidationResult {
  valid: boolean;
  errors: string[];
}

const SEARCH_RESULTS_LIMIT = 10;
const SEARCH_SKIP_PROPS = new Set(['id', 'z', 'x', 'y', 'wires']);

export const FLOW_SORT_KEY_FNS: Record<
  FlowSortKey,
  (f: FlowSortable) => string | number | boolean
> = {
  label: f => String(f.label ?? '').toLowerCase(),
  nodeCount: f => (typeof f.nodeCount === 'number' ? f.nodeCount : (f.nodes?.length ?? 0)),
  disabled: f => Boolean(f.disabled),
};

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asPartialFlow(value: unknown): Partial<NodeRedFlow> {
  return value as Partial<NodeRedFlow>;
}

function textResult(text: string): CallToolResponse {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(data: unknown): CallToolResponse {
  return textResult(JSON.stringify(data, null, 2));
}

function okResult(data: unknown, timestamp: string, rev?: string): ToolOutcome {
  const result: McpToolResult = { success: true, data, timestamp };
  if (rev !== undefined) result.rev = rev;
  return { kind: 'result', result };
}

export function validateFlowData(flow: { nodes?: unknown[] }): FlowValidationResult {
  const errors: string[] = [];
  const nodes = Array.isArray(flow.nodes) ? (flow.nodes as Record<string, unknown>[]) : [];
  const nodeIds = new Set<string>();

  for (const [i, node] of nodes.entries()) {
    const id = typeof node.id === 'string' ? node.id : '';
    const label = id ? `Node "${id}"` : `Node[${i}]`;

    if (!id) errors.push(`${label}: missing required field "id"`);
    if (!node.type) errors.push(`${label}: missing required field "type"`);

    if (id) {
      if (nodeIds.has(id)) {
        errors.push(`Duplicate node ID: "${id}"`);
      } else {
        nodeIds.add(id);
      }
    }
  }

  for (const [i, node] of nodes.entries()) {
    const id = typeof node.id === 'string' ? node.id : '';
    const label = id ? `Node "${id}"` : `Node[${i}]`;
    if (!Array.isArray(node.wires)) continue;
    for (const group of node.wires as unknown[]) {
      if (!Array.isArray(group)) {
        errors.push(`${label}: wires must be an array of arrays`);
        continue;
      }
      for (const target of group as unknown[]) {
        if (typeof target !== 'string') {
          errors.push(`${label}: wire target must be a string`);
          continue;
        }
        if (!nodeIds.has(target)) {
          errors.push(`${label}: wire references unknown node "${target}"`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateFlowOrThrow(flowData: { nodes?: unknown[] }): void {
  const validation = validateFlowData(flowData);
  if (!validation.valid) {
    throw new Error(`Validation failed:\n${validation.errors.map(e => `- ${e}`).join('\n')}`);
  }
}

export interface ToolExecContext {
  nodeRedClient: NodeRedAPIClient;
  semanticIndex: SemanticFlowIndex;
  resolveFlowId: (args: ToolArgs, verb: string) => Promise<string>;
  tryElicitString: (message: string, title: string, field: string) => Promise<string | null>;
  tryElicitConfirm: (message: string) => Promise<boolean>;
}

type ToolHandler = (
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
) => Promise<ToolOutcome>;

async function handleGetFlows(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  // Preserve legacy coercion: non-boolean truthy includeDetails still requests details.
  const includeDetails = (args.includeDetails as boolean | undefined) ?? false;
  const types = (args.types as string[] | undefined) ?? ['tab', 'subflow'];
  // Fetch rev alongside the legacy data shape so deploy_* can use
  // expected_rev without breaking existing consumers of `data`.
  const [{ rev }, flowDataRaw] = await Promise.all([
    ctx.nodeRedClient.getFlowsWithRev(),
    includeDetails
      ? ctx.nodeRedClient.getFlows()
      : ctx.nodeRedClient.getFlowSummaries(types),
  ]);
  let flowData: FlowSortable[] = flowDataRaw;

  const { sortBy, order } = parseSort(args, FLOW_SORT_KEYS);

  if (args.disabled !== undefined) {
    const wantDisabled = Boolean(args.disabled);
    flowData = flowData.filter(f => Boolean(f.disabled) === wantDisabled);
  }
  if (typeof args.labelContains === 'string') {
    const q = args.labelContains;
    flowData = flowData.filter(f => caseInsensitiveIncludes(f.label, q));
  }

  if (sortBy) {
    flowData = stableSortBy(flowData, FLOW_SORT_KEY_FNS[sortBy], order);
  }

  if (isPaginated(args)) {
    return okResult(applyPagination(flowData, args), timestamp, rev);
  }
  return okResult(flowData, timestamp, rev);
}

async function handleGetFlow(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  const flowId = await ctx.resolveFlowId(args, 'get');
  const [flow, { rev }] = await Promise.all([
    ctx.nodeRedClient.getFlow(flowId),
    ctx.nodeRedClient.getFlowsWithRev(),
  ]);
  return okResult(flow, timestamp, rev);
}

async function handleValidateFlow(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  const flowId = await ctx.resolveFlowId(args, 'validate');
  const flow = await ctx.nodeRedClient.getFlow(flowId);
  return okResult(validateFlowData(flow), timestamp);
}

async function handleCreateFlow(
  ctx: ToolExecContext,
  args: ToolArgs,
  _timestamp: string
): Promise<ToolOutcome> {
  validateRequired(args, ['flowData']);
  if (args.validate) validateFlowOrThrow(asPartialFlow(args.flowData));
  const createdFlow = await ctx.nodeRedClient.createFlow(asPartialFlow(args.flowData));
  return {
    kind: 'content',
    response: textResult(`Flow created: ${createdFlow.id || createdFlow.label}`),
  };
}

async function handleReplaceFlow(
  ctx: ToolExecContext,
  args: ToolArgs,
  _timestamp: string
): Promise<ToolOutcome> {
  // update_flow is a deprecated alias for replace_flow (same PUT /flow/:id).
  const flowId = await ctx.resolveFlowId(args, 'replace');
  if (!args.flowData) throw new Error('Missing required parameter: flowData');
  if (args.validate) validateFlowOrThrow(asPartialFlow(args.flowData));
  await ctx.nodeRedClient.updateFlow(flowId, asPartialFlow(args.flowData));
  return {
    kind: 'content',
    response: textResult(`Flow ${flowId} replaced successfully`),
  };
}

async function handleDeployFlow(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  const flowId = await ctx.resolveFlowId(args, 'deploy');
  if (!args.flowData) throw new Error('Missing required parameter: flowData');
  const expectedRev = args.expected_rev;
  if (typeof expectedRev !== 'string' || expectedRev.length === 0) {
    throw new Error(
      'Missing required parameter: expected_rev (from get_flows / get_flow `rev`)'
    );
  }
  if (args.validate) validateFlowOrThrow(asPartialFlow(args.flowData));
  const deployType = args.type === 'nodes' ? 'nodes' : 'flows';
  const deployed = await ctx.nodeRedClient.deployFlow(flowId, asPartialFlow(args.flowData), {
    expectedRev,
    type: deployType,
  });
  return {
    kind: 'content',
    response: jsonResult({
      success: true,
      message: `Deployed flow ${flowId} (type=${deployType})`,
      rev: deployed.rev,
      timestamp,
    }),
  };
}

async function handleDeployNodes(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  const rawNodes = args.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new Error('Missing required parameter: nodes (non-empty array)');
  }
  // Array.isArray(unknown) narrows to any[]; re-bind as unknown[] for safe checks.
  const nodes: unknown[] = rawNodes;
  const expectedRev = args.expected_rev;
  if (typeof expectedRev !== 'string' || expectedRev.length === 0) {
    throw new Error(
      'Missing required parameter: expected_rev (from get_flows / get_flow `rev`)'
    );
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error(`nodes[${i}] must be a node object`);
    }
    const rec = node as Record<string, unknown>;
    if (typeof rec.id !== 'string' || rec.id.length === 0) {
      throw new Error(`nodes[${i}] needs a non-empty string id`);
    }
    if (typeof rec.type !== 'string' || rec.type.length === 0) {
      throw new Error(`nodes[${i}] (id=${rec.id}) needs a non-empty string type`);
    }
    if (seenIds.has(rec.id)) {
      throw new Error(`Duplicate node id in nodes: ${rec.id}`);
    }
    seenIds.add(rec.id);
  }
  const credentials = args.credentials;
  if (
    credentials !== undefined &&
    (credentials === null || typeof credentials !== 'object' || Array.isArray(credentials))
  ) {
    throw new Error('credentials must be an object keyed by node id (or encrypted `$` form)');
  }
  const typedNodes = nodes as NodeRedNode[];
  const deployed = await ctx.nodeRedClient.deployModifiedNodes(
    typedNodes,
    expectedRev,
    credentials === undefined ? undefined : (credentials as Record<string, unknown>)
  );
  return {
    kind: 'content',
    response: jsonResult({
      success: true,
      message: `Deployed ${nodes.length} node(s): ${typedNodes.map(n => n.id).join(', ')}`,
      rev: deployed.rev,
      timestamp,
    }),
  };
}

async function handleEnableFlow(
  ctx: ToolExecContext,
  args: ToolArgs,
  _timestamp: string
): Promise<ToolOutcome> {
  const flowId = await ctx.resolveFlowId(args, 'enable');
  await ctx.nodeRedClient.enableFlow(flowId);
  return { kind: 'content', response: textResult(`Flow ${flowId} enabled`) };
}

async function handleDisableFlow(
  ctx: ToolExecContext,
  args: ToolArgs,
  _timestamp: string
): Promise<ToolOutcome> {
  const flowId = await ctx.resolveFlowId(args, 'disable');
  await ctx.nodeRedClient.disableFlow(flowId);
  return { kind: 'content', response: textResult(`Flow ${flowId} disabled`) };
}

async function handleSearchModules(
  ctx: ToolExecContext,
  args: ToolArgs,
  _timestamp: string
): Promise<ToolOutcome> {
  const query =
    (args.query as string | null | undefined) ??
    (await ctx.tryElicitString(
      'What would you like to search for in Node-RED modules? (e.g., "mqtt", "dashboard")',
      'Search query',
      'query'
    ));
  if (!query) throw new Error('Missing required parameter: query');
  const searchResults = await ctx.nodeRedClient.searchModules(
    query,
    (args.category as ModuleCategory | undefined) ?? 'all',
    (args.limit as number | undefined) ?? 10
  );
  return { kind: 'content', response: jsonResult(searchResults) };
}

async function handleInstallModule(
  ctx: ToolExecContext,
  args: ToolArgs,
  _timestamp: string
): Promise<ToolOutcome> {
  validateRequired(args, ['moduleName']);
  const moduleName = args.moduleName as string;
  const moduleVersion = args.version as string | undefined;
  const installResult = await ctx.nodeRedClient.installModule(moduleName, moduleVersion);
  return { kind: 'content', response: jsonResult(installResult) };
}

async function handleGetInstalledModules(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  const installedModules = await ctx.nodeRedClient.getInstalledModules();
  const queryFilter = args.query;
  const hasNewParams = isPaginated(args) || typeof queryFilter === 'string';

  if (!hasNewParams) {
    return { kind: 'content', response: jsonResult(installedModules) };
  }

  let modules: (NodeRedModule | string)[] = Array.isArray(installedModules)
    ? installedModules
    : [];
  if (typeof queryFilter === 'string') {
    modules = modules.filter(m => {
      if (typeof m === 'string') return caseInsensitiveIncludes(m, queryFilter);
      // NodeRedModule.name is required; keep id fallback for atypical shapes via unknown.
      const legacy = m as unknown as { name?: string; id?: string };
      const name = legacy.name ?? legacy.id ?? '';
      return caseInsensitiveIncludes(name, queryFilter);
    });
  }
  return okResult(applyPagination(modules, args), timestamp);
}

async function handleGetContext(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  const scope = (args.scope as string | undefined) ?? 'global';
  const key = args.key as string | undefined;
  if (scope === 'flow') {
    validateRequired(args, ['flowId']);
  }
  const contextData =
    scope === 'flow'
      ? await ctx.nodeRedClient.getFlowContext(args.flowId as string, key)
      : await ctx.nodeRedClient.getGlobalContext(key);
  return okResult(contextData, timestamp);
}

async function handleSetContext(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  validateRequired(args, ['key', 'value']);
  const scope = (args.scope as string | undefined) ?? 'global';
  if (scope === 'flow') {
    validateRequired(args, ['flowId']);
    await ctx.nodeRedClient.setFlowContext(
      args.flowId as string,
      args.key as string,
      args.value
    );
  } else {
    await ctx.nodeRedClient.setGlobalContext(args.key as string, args.value);
  }
  return okResult({ scope, key: args.key }, timestamp);
}

async function handleDeleteContext(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  validateRequired(args, ['key']);
  await ctx.nodeRedClient.deleteGlobalContext(args.key as string);
  return okResult({ key: args.key }, timestamp);
}

async function handleDeleteFlow(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  const flowId = await ctx.resolveFlowId(args, 'delete');
  const dryRun = args.dryRun !== false;
  const flow = await ctx.nodeRedClient.getFlow(flowId);
  const flowInfo = {
    id: flow.id,
    label: flow.label ?? '',
    nodeCount: flow.nodes.length,
  };

  if (dryRun) {
    return okResult({ dryRun: true, wouldDelete: flowInfo }, timestamp);
  }

  let confirmed = Boolean(args.confirm);
  if (!confirmed) {
    confirmed = await ctx.tryElicitConfirm(
      `Delete flow "${flowInfo.label || flowId}"? This will permanently remove ${flowInfo.nodeCount} node(s) and cannot be undone.`
    );
  }
  if (!confirmed) throw new Error('Deletion requires confirm: true and dryRun: false');

  await ctx.nodeRedClient.deleteFlow(flowId);
  return okResult({ deleted: flowInfo }, timestamp);
}

function nodeMatchesSearch(
  node: NodeRedNode,
  typeFilterLower: string | undefined,
  nodeTypePrefixLower: string | undefined,
  queryLower: string | undefined
): boolean {
  const nodeTypeLower = node.type.toLowerCase();
  if (typeFilterLower && !nodeTypeLower.includes(typeFilterLower)) return false;
  if (nodeTypePrefixLower && !nodeTypeLower.startsWith(nodeTypePrefixLower)) return false;
  if (!queryLower) return true;

  if ((node.name ?? '').toLowerCase().includes(queryLower)) return true;
  for (const k of Object.keys(node)) {
    if (SEARCH_SKIP_PROPS.has(k) || k === 'name') continue;
    const v = (node as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.toLowerCase().includes(queryLower)) {
      return true;
    }
  }
  return false;
}

async function handleSearchFlows(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  const typeFilter = asString(args.type);
  const query = asString(args.query);
  const filterFlowId = asString(args.flowId);
  const nodeTypePrefix = asString(args.nodeTypePrefix);
  const excludeFlowIds = Array.isArray(args.excludeFlowIds)
    ? new Set(args.excludeFlowIds as string[])
    : undefined;

  if (!typeFilter && !query && !filterFlowId && !nodeTypePrefix) {
    throw new Error(
      'At least one search parameter is required: type, query, flowId, or nodeTypePrefix'
    );
  }

  const flows = await ctx.nodeRedClient.getFlows();
  const typeFilterLower = typeFilter?.toLowerCase();
  const queryLower = query?.toLowerCase();
  const nodeTypePrefixLower = nodeTypePrefix?.toLowerCase();

  const paginated = isPaginated(args);
  const { limit: pageLimit, offset: pageOffset } = paginated
    ? parsePagination(args)
    : { limit: SEARCH_RESULTS_LIMIT, offset: 0 };
  const windowEnd = pageOffset + pageLimit;
  const matches: FlowSearchMatch[] = [];
  let total = 0;

  for (const flow of flows) {
    if (filterFlowId && flow.id !== filterFlowId) continue;
    if (excludeFlowIds?.has(flow.id)) continue;
    for (const node of flow.nodes) {
      if (!nodeMatchesSearch(node, typeFilterLower, nodeTypePrefixLower, queryLower)) {
        continue;
      }
      if (total >= pageOffset && total < windowEnd) {
        matches.push({
          nodeId: node.id,
          nodeType: node.type,
          nodeName: node.name ?? '',
          flowId: flow.id,
          flowLabel: flow.label ?? '',
        });
      }
      total++;
    }
  }

  if (paginated) {
    return okResult(
      {
        items: matches,
        total,
        limit: pageLimit,
        offset: pageOffset,
        hasMore: pageOffset + matches.length < total,
      },
      timestamp
    );
  }
  return okResult({ matches, total }, timestamp);
}

async function handleGetFlowState(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  const status: NodeRedFlowStatus = await ctx.nodeRedClient.getFlowStatus();
  if (isPaginated(args)) {
    const flows = Array.isArray(status.flows) ? status.flows : [];
    const envelope = applyPagination(flows, args);
    return okResult({ state: status.state, ...envelope }, timestamp);
  }
  return okResult(status, timestamp);
}

async function handleGetSettings(
  ctx: ToolExecContext,
  _args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  return okResult(await ctx.nodeRedClient.getSettings(), timestamp);
}

async function handleGetRuntimeInfo(
  ctx: ToolExecContext,
  _args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  return okResult(await ctx.nodeRedClient.getRuntimeInfo(), timestamp);
}

async function handleGetNodeErrors(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  const checker = new NodeErrorChecker(ctx.nodeRedClient);
  const timeoutMs = args.timeoutMs;
  const data = await checker.check({
    includeWarnings: (args.includeWarnings as boolean | undefined) ?? false,
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  });
  return okResult(data, timestamp);
}

async function handleSemanticSearchFlows(
  ctx: ToolExecContext,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  const query =
    (args.query as string | null | undefined) ??
    (await ctx.tryElicitString(
      'What are you looking for in your Node-RED flows?',
      'Search query',
      'query'
    ));
  if (!query) throw new Error('Missing required parameter: query');
  if (args.refresh) await ctx.semanticIndex.refresh();
  const results = await ctx.semanticIndex.search(
    query,
    (args.topK as number | undefined) ?? 10,
    (args.scope as SemanticScope | undefined) ?? 'all'
  );
  return okResult(results, timestamp);
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_flows: handleGetFlows,
  get_flow: handleGetFlow,
  validate_flow: handleValidateFlow,
  create_flow: handleCreateFlow,
  replace_flow: handleReplaceFlow,
  update_flow: handleReplaceFlow,
  deploy_flow: handleDeployFlow,
  deploy_nodes: handleDeployNodes,
  enable_flow: handleEnableFlow,
  disable_flow: handleDisableFlow,
  search_modules: handleSearchModules,
  install_module: handleInstallModule,
  get_installed_modules: handleGetInstalledModules,
  get_context: handleGetContext,
  set_context: handleSetContext,
  delete_context: handleDeleteContext,
  delete_flow: handleDeleteFlow,
  search_flows: handleSearchFlows,
  get_flow_state: handleGetFlowState,
  get_settings: handleGetSettings,
  get_runtime_info: handleGetRuntimeInfo,
  get_node_errors: handleGetNodeErrors,
  semantic_search_flows: handleSemanticSearchFlows,
};

export async function executeTool(
  ctx: ToolExecContext,
  name: string,
  args: ToolArgs,
  timestamp: string
): Promise<ToolOutcome> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(ctx, args, timestamp);
}
