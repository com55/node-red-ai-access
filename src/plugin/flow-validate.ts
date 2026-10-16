/**
 * Shared flow / patch validation: hard errors only for definitely-wrong wires
 * (excess ports / bad shape / missing targets); soft warnings for scaffold-
 * friendly gaps (missing config, unwired nodes, fewer ports than outputs).
 */

import type { FlowNode, FlowTab } from '../runtime/types.js';

import { AiOpsValidationError } from './ai-ops.js';
import { getNodeTypeDetail, requireNodeTypeName, type NodeTypesAdapter } from './node-types.js';

export interface ValidationIssue {
  code: string;
  error: string;
  nodeId?: string;
  type?: string;
  property?: string;
  configType?: string;
  candidates?: string[];
  [key: string]: unknown;
}

/**
 * Throw a single AiOpsValidationError that always includes `errors: [...]`.
 *
 * One issue → that issue's own code/status (e.g. 404 `node_not_found`).
 * Several issues → 400 `validation_failed` with message `N validation errors`
 * and every issue listed in `errors[]`.
 */
export function throwValidationIssues(issues: ValidationIssue[]): void {
  if (issues.length === 0) {
    return;
  }
  const primary = issues[0];
  if (!primary) {
    return;
  }
  // errors[] entries never carry statusCode (HTTP status lives on the response).
  const listed = issues.map(issue => {
    const rest: ValidationIssue = { ...issue };
    delete rest.statusCode;
    return rest;
  });
  if (issues.length > 1) {
    throw new AiOpsValidationError(`${issues.length} validation errors`, 'validation_failed', {
      statusCode: 400,
      details: { errors: listed, errorCount: issues.length },
    });
  }
  const details: Record<string, unknown> = { errors: listed };
  for (const [k, v] of Object.entries(primary)) {
    if (k === 'code' || k === 'error' || k === 'errors' || k === 'statusCode') {
      continue;
    }
    if (v !== undefined) {
      details[k] = v;
    }
  }
  const statusCode = typeof primary.statusCode === 'number' ? primary.statusCode : 400;
  // Top-level message is the specific issue text (e.g. which node was missing).
  throw new AiOpsValidationError(primary.error, primary.code, { statusCode, details });
}

/**
 * Report every node id that appears more than once across `nodes` + `configs`
 * as `duplicate_node_id` (one issue per duplicated id).
 */
export function collectDuplicateNodeIdIssues(
  lists: readonly (readonly unknown[])[],
  where = 'payload.flow'
): ValidationIssue[] {
  const counts = new Map<string, number>();
  for (const list of lists) {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const id = (raw as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  const issues: ValidationIssue[] = [];
  for (const [id, count] of counts) {
    if (count > 1) {
      issues.push({
        code: 'duplicate_node_id',
        error: `Node id '${id}' appears ${count} times in ${where}; node ids must be unique`,
        nodeId: id,
        count,
      });
    }
  }
  return issues;
}

function describeLiveNode(node: FlowNode): string {
  const label = typeof node.label === 'string' && node.label ? ` '${node.label}'` : '';
  if (node.type === 'tab') return `tab${label || ` '${node.id}'`}`;
  if (node.type === 'subflow') return `subflow${label || ` '${node.id}'`}`;
  if (typeof node.z === 'string' && node.z) return `${node.type} node on '${node.z}'`;
  return `global ${node.type} config node`;
}

/**
 * Node ids must be unique across the WHOLE resulting flows file. Replacing tab
 * `flowId` keeps every live entry that is not the tab itself and not on that
 * tab (other tabs, their nodes, subflows, global configs), so a proposed node
 * may not reuse any of those ids nor the tab id.
 */
export function collectCrossFlowDuplicateIssues(
  flow: Partial<FlowTab>,
  flowId: string,
  liveFlows: readonly FlowNode[]
): ValidationIssue[] {
  const elsewhere = new Map<string, FlowNode>();
  for (const node of liveFlows) {
    if (!node || typeof node.id !== 'string') continue;
    if (node.id === flowId || node.z === flowId) continue;
    elsewhere.set(node.id, node);
  }
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const list of [flow.nodes, flow.configs]) {
    if (!Array.isArray(list)) continue;
    for (const node of list) {
      const id = node && typeof node === 'object' ? node.id : undefined;
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      if (id === flowId) {
        issues.push({
          code: 'duplicate_node_id',
          error: `Node id '${id}' equals the tab id; node ids must be unique across all flows`,
          nodeId: id,
        });
        continue;
      }
      const other = elsewhere.get(id);
      if (other) {
        issues.push({
          code: 'duplicate_node_id',
          error: `Node id '${id}' is already used by ${describeLiveNode(other)}; node ids must be unique across all flows`,
          nodeId: id,
        });
      }
    }
  }
  return issues;
}

const IGNORE_TOUCH_KEYS = new Set(['x', 'y', 'w', 'h', 'g', 'id', 'z']);

function collectNodesMap(flow: Partial<FlowTab>): Map<string, FlowNode> {
  const map = new Map<string, FlowNode>();
  for (const list of [flow.nodes, flow.configs]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list as unknown[]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const node = entry as FlowNode;
      if (typeof node.id === 'string') {
        map.set(node.id, node);
      }
    }
  }
  return map;
}

function nodeContentChanged(prev: FlowNode, next: FlowNode): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (IGNORE_TOUCH_KEYS.has(key)) continue;
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      return true;
    }
  }
  return false;
}

/** Node ids added or content-changed vs a base snapshot (for soft-warning scoping). */
export function changedNodeIds(
  baseFlow: Partial<FlowTab> | undefined,
  afterFlow: Partial<FlowTab>
): Set<string> {
  const after = collectNodesMap(afterFlow);
  if (!baseFlow) {
    return new Set(after.keys());
  }
  const before = collectNodesMap(baseFlow);
  const out = new Set<string>();
  for (const [id, node] of after) {
    const prev = before.get(id);
    if (!prev || nodeContentChanged(prev, node)) {
      out.add(id);
    }
  }
  return out;
}

/**
 * Shape checks for a full replace_flow tab (same bar as patch ops):
 * string id + type on every node/config; wires shape; flow.id matches flowId;
 * nodes/configs must be arrays when present.
 */
export function collectFullFlowShapeIssues(
  flow: Partial<FlowTab> | Record<string, unknown>,
  flowId: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tab = flow as Record<string, unknown>;

  if (typeof tab.id !== 'string' || tab.id.length === 0) {
    issues.push({
      code: 'missing_flow_id',
      error: 'payload.flow.id is required and must match payload.flowId',
    });
  } else if (tab.id !== flowId) {
    issues.push({
      code: 'invalid_flow_id',
      error: `payload.flow.id ('${tab.id}') must match payload.flowId ('${flowId}')`,
    });
  }

  if (!('nodes' in tab)) {
    issues.push({
      code: 'invalid_nodes',
      error: 'payload.flow.nodes must be an array (use [] to clear the tab intentionally)',
    });
  } else if (!Array.isArray(tab.nodes)) {
    issues.push({
      code: 'invalid_nodes',
      error: 'payload.flow.nodes must be an array',
    });
  }

  if ('configs' in tab && tab.configs !== undefined && !Array.isArray(tab.configs)) {
    issues.push({
      code: 'invalid_nodes',
      error: 'payload.flow.configs must be an array',
    });
  }

  const lists: { key: string; list: unknown[] }[] = [];
  if (Array.isArray(tab.nodes)) {
    lists.push({ key: 'nodes', list: tab.nodes as unknown[] });
  }
  if (Array.isArray(tab.configs)) {
    lists.push({ key: 'configs', list: tab.configs as unknown[] });
  }
  issues.push(...collectDuplicateNodeIdIssues(lists.map(l => l.list)));
  for (const { key, list } of lists) {
    for (let i = 0; i < list.length; i += 1) {
      const raw: unknown = list[i];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push({
          code: 'invalid_node',
          error: `payload.flow.${key}[${i}] must be an object`,
        });
        continue;
      }
      const node = raw as Record<string, unknown>;
      if (typeof node.id !== 'string' || node.id.length === 0) {
        issues.push({
          code: 'missing_node_id',
          error: `payload.flow.${key}[${i}] needs a non-empty string id`,
        });
      }
      try {
        requireNodeTypeName(node.type, 'node.type');
      } catch (e) {
        if (e instanceof AiOpsValidationError) {
          issues.push({
            code: e.code,
            error: e.message,
            ...(typeof node.id === 'string' ? { nodeId: node.id } : {}),
          });
        }
      }
      if ('wires' in node) {
        assertValidWiresShape(
          node.wires,
          issues,
          typeof node.id === 'string' ? node.id : undefined
        );
      }
    }
  }

  return issues;
}

export function assertValidWiresShape(
  value: unknown,
  issues: ValidationIssue[],
  nodeId?: string
): value is unknown[][] {
  if (!Array.isArray(value)) {
    issues.push({
      code: 'invalid_wires',
      error: 'wires must be an array of output ports (each a list of node ids)',
      ...(nodeId ? { nodeId } : {}),
    });
    return false;
  }
  for (const port of value) {
    if (!Array.isArray(port)) {
      issues.push({
        code: 'invalid_wires',
        error: 'wires must be an array of output ports (each a list of node ids)',
        ...(nodeId ? { nodeId } : {}),
      });
      return false;
    }
    for (const target of port) {
      if (typeof target !== 'string' || target.length === 0) {
        issues.push({
          code: 'invalid_wires',
          error: 'wires targets must be non-empty node id strings',
          ...(nodeId ? { nodeId } : {}),
        });
        return false;
      }
    }
  }
  return true;
}

/**
 * Resolve how many outputs a node should have: prefer instance `node.outputs`
 * (function/switch), else registry `outputs`.
 */
export async function resolveNodeOutputCount(
  node: FlowNode,
  adapter?: NodeTypesAdapter
): Promise<number | undefined> {
  if (typeof node.outputs === 'number' && Number.isFinite(node.outputs) && node.outputs >= 0) {
    return Math.trunc(node.outputs);
  }
  const typeName = typeof node.type === 'string' ? node.type : '';
  if (!adapter || !typeName) {
    return undefined;
  }
  try {
    const detail = await getNodeTypeDetail(adapter, typeName, { includeHelp: false });
    return detail.outputs;
  } catch {
    return undefined;
  }
}

/**
 * Hard error only when there are **more** wire port arrays than outputs
 * (wiring from a port that does not exist). Fewer ports than outputs is OK
 * (Node-RED pads) and may yield a soft warning elsewhere.
 */
export function wireCountIssue(
  node: FlowNode,
  outputs: number,
  wires: unknown[]
): ValidationIssue | undefined {
  const typeName = typeof node.type === 'string' ? node.type : 'node';
  if (wires.length <= outputs) {
    return undefined;
  }
  if (outputs === 0) {
    return {
      code: 'invalid_wires',
      error: `${typeName} has 0 outputs; wires must be []`,
      nodeId: node.id,
      type: typeName,
    };
  }
  return {
    code: 'invalid_wires',
    error: `${typeName} has ${outputs} outputs; wires has ${wires.length} port arrays (max ${outputs})`,
    nodeId: node.id,
    type: typeName,
  };
}

function portHasTargets(port: unknown): boolean {
  return Array.isArray(port) && port.some(t => typeof t === 'string' && t.length > 0);
}

function nodeIsUnwired(node: FlowNode, outputs: number): boolean {
  if (outputs <= 0) {
    return false;
  }
  if (!('wires' in node) || node.wires === undefined) {
    return true;
  }
  if (!Array.isArray(node.wires)) {
    return false;
  }
  return !(node.wires as unknown[]).some(portHasTargets);
}

export interface WireValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface WireValidationOptions {
  /**
   * When set, emit `unwired_node` / `incomplete_wires` only for these node ids
   * (nodes the proposal adds or changes). Hard wire errors still cover all nodes.
   */
  softWarningNodeIds?: Set<string>;
}

/**
 * Hard errors: bad shape, excess ports vs outputs, missing wire targets.
 * Soft warnings: fewer ports than outputs, unwired nodes (outputs > 0, no links).
 */
export async function collectWireValidation(
  nodes: FlowNode[],
  adapter?: NodeTypesAdapter,
  options: WireValidationOptions = {}
): Promise<WireValidationResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const ids = new Set(nodes.map(n => n.id));
  const softIds = options.softWarningNodeIds;

  for (const node of nodes) {
    const outputs = await resolveNodeOutputCount(node, adapter);
    const typeName = typeof node.type === 'string' ? node.type : 'node';
    const softOk = !softIds || softIds.has(node.id);

    if ('wires' in node && node.wires !== undefined) {
      if (!assertValidWiresShape(node.wires, errors, node.id)) {
        continue;
      }
      const wires = node.wires as unknown[];
      if (outputs !== undefined) {
        const countIssue = wireCountIssue(node, outputs, wires);
        if (countIssue) {
          // Distinguish excess-port cause for channel hints.
          countIssue.cause = 'excess_ports';
          errors.push(countIssue);
        } else if (softOk && wires.length < outputs) {
          warnings.push({
            code: 'incomplete_wires',
            error: `${typeName} '${node.id}' declares ${outputs} outputs but wires has only ${wires.length} port(s)`,
            nodeId: node.id,
            type: typeName,
          });
        }
      }
      for (const port of wires) {
        for (const target of port as unknown[]) {
          const id = String(target);
          if (!ids.has(id)) {
            errors.push({
              code: 'invalid_wires',
              error: `Wire target '${id}' on node '${node.id}' was not found in this flow (add the node in the same patch or use an existing id)`,
              nodeId: node.id,
              cause: 'missing_target',
              targetId: id,
            });
          }
        }
      }
    }

    if (softOk && outputs !== undefined && nodeIsUnwired(node, outputs)) {
      warnings.push({
        code: 'unwired_node',
        error: `Node '${node.id}' (${typeName}) has ${outputs} output(s) but is not wired to anything yet`,
        nodeId: node.id,
        type: typeName,
      });
    }
  }
  return { errors, warnings };
}

/** @deprecated Prefer collectWireValidation — returns hard errors only. */
export async function collectWireIssues(
  nodes: FlowNode[],
  adapter?: NodeTypesAdapter
): Promise<ValidationIssue[]> {
  const { errors } = await collectWireValidation(nodes, adapter);
  return errors;
}

export function collectZMismatchIssues(nodes: FlowNode[], flowId: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of nodes) {
    if (node.z === undefined || node.z === '') {
      continue;
    }
    if (typeof node.z === 'string' && node.z !== flowId) {
      issues.push({
        code: 'z_mismatch',
        error: `Node '${node.id}' has z='${node.z}' but flow id is '${flowId}'`,
        nodeId: node.id,
      });
    }
  }
  return issues;
}

function configCandidates(configs: FlowNode[], configType: string): string[] {
  return configs.filter(c => c.type === configType).map(c => c.id);
}

/**
 * Soft warnings for missing / empty / unresolved config-node refs.
 * Never hard-errors — AI may scaffold nodes before a human picks a broker.
 */
export async function collectConfigWarnings(
  nodes: FlowNode[],
  configs: FlowNode[],
  adapter: NodeTypesAdapter
): Promise<ValidationIssue[]> {
  const warnings: ValidationIssue[] = [];
  const allConfigs = [...configs];

  for (const node of nodes) {
    let typeName: string;
    try {
      typeName = requireNodeTypeName(node.type, 'node.type');
    } catch {
      continue;
    }
    let detail;
    try {
      detail = await getNodeTypeDetail(adapter, typeName, { includeHelp: false });
    } catch {
      continue;
    }
    const defaults = detail.defaults;
    if (!defaults || typeof defaults !== 'object') {
      continue;
    }
    const requiredTypes = new Set(detail.requiredConfigNodeTypes ?? []);

    for (const [prop, def] of Object.entries(defaults)) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) {
        continue;
      }
      const cfgType = (def as { type?: unknown }).type;
      if (typeof cfgType !== 'string' || !cfgType) {
        continue;
      }
      const requiredFlag = (def as { required?: unknown }).required === true;
      const isRequired = requiredFlag || requiredTypes.has(cfgType);
      const value = node[prop];
      const candidates = configCandidates(allConfigs, cfgType);

      if (typeof value !== 'string' || value.length === 0) {
        if (isRequired) {
          warnings.push({
            code: 'missing_config_node',
            error: `Node '${node.id}' (${typeName}) has no ${cfgType} on '${prop}' yet — configure before deploy if needed`,
            nodeId: node.id,
            type: typeName,
            property: prop,
            configType: cfgType,
            candidates,
          });
        }
        continue;
      }

      const found = allConfigs.find(c => c.id === value);
      if (found?.type !== cfgType) {
        warnings.push({
          code: 'missing_config_node',
          error: `Node '${node.id}' property '${prop}' does not resolve to a ${cfgType} config yet`,
          nodeId: node.id,
          type: typeName,
          property: prop,
          configType: cfgType,
          candidates,
        });
      }
    }
  }
  return warnings;
}

/**
 * @deprecated Config gaps are warnings only — use collectConfigWarnings.
 * Always returns [] (kept so older call sites compile until updated).
 */
export function collectMissingConfigIssues(
  _nodes: FlowNode[],
  _configs: FlowNode[],
  _adapter: NodeTypesAdapter
): Promise<ValidationIssue[]> {
  return Promise.resolve([]);
}

/** Validate a full flow tab (replace_flow): hard errors + soft warnings. */
export async function validateFlowTab(
  flow: Partial<FlowTab> | FlowTab,
  options: {
    flowId?: string;
    nodeTypes?: NodeTypesAdapter;
    /** When set, soft wire warnings only for nodes added/changed vs this base. */
    baseFlow?: Partial<FlowTab>;
  } = {}
): Promise<{ errors: ValidationIssue[]; warnings: ValidationIssue[] }> {
  const flowId = options.flowId ?? (typeof flow.id === 'string' ? flow.id : '');
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const configs = Array.isArray(flow.configs) ? flow.configs : [];
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (flowId) {
    errors.push(...collectZMismatchIssues(nodes, flowId));
  }
  const softWarningNodeIds = options.baseFlow ? changedNodeIds(options.baseFlow, flow) : undefined;
  const wire = await collectWireValidation(nodes, options.nodeTypes, {
    ...(softWarningNodeIds ? { softWarningNodeIds } : {}),
  });
  errors.push(...wire.errors);
  warnings.push(...wire.warnings);
  if (options.nodeTypes) {
    const configWarnings = await collectConfigWarnings(nodes, configs, options.nodeTypes);
    if (softWarningNodeIds) {
      warnings.push(...configWarnings.filter(w => !w.nodeId || softWarningNodeIds.has(w.nodeId)));
    } else {
      warnings.push(...configWarnings);
    }
  }
  return { errors, warnings };
}
