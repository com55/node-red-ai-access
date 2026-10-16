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

/** Throw a single AiOpsValidationError that always includes `errors: [...]`. */
export function throwValidationIssues(issues: ValidationIssue[]): void {
  if (issues.length === 0) {
    return;
  }
  const primary = issues[0];
  if (!primary) {
    return;
  }
  const code = issues.length === 1 ? primary.code : 'validation_failed';
  const message = issues.length === 1 ? primary.error : `${issues.length} validation errors`;
  const details: Record<string, unknown> = { errors: issues };
  for (const [k, v] of Object.entries(primary)) {
    if (k === 'code' || k === 'error' || k === 'errors' || k === 'statusCode') {
      continue;
    }
    if (v !== undefined) {
      details[k] = v;
    }
  }
  const statusCode =
    issues.length === 1 && typeof primary.statusCode === 'number' ? primary.statusCode : 400;
  throw new AiOpsValidationError(message, code, { statusCode, details });
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

/**
 * Hard errors: bad shape, excess ports vs outputs, missing wire targets.
 * Soft warnings: fewer ports than outputs, unwired nodes (outputs > 0, no links).
 */
export async function collectWireValidation(
  nodes: FlowNode[],
  adapter?: NodeTypesAdapter
): Promise<WireValidationResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const ids = new Set(nodes.map(n => n.id));

  for (const node of nodes) {
    const outputs = await resolveNodeOutputCount(node, adapter);
    const typeName = typeof node.type === 'string' ? node.type : 'node';

    if ('wires' in node && node.wires !== undefined) {
      if (!assertValidWiresShape(node.wires, errors, node.id)) {
        continue;
      }
      const wires = node.wires as unknown[];
      if (outputs !== undefined) {
        const countIssue = wireCountIssue(node, outputs, wires);
        if (countIssue) {
          errors.push(countIssue);
        } else if (wires.length < outputs) {
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
            });
          }
        }
      }
    }

    if (outputs !== undefined && nodeIsUnwired(node, outputs)) {
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
  options: { flowId?: string; nodeTypes?: NodeTypesAdapter } = {}
): Promise<{ errors: ValidationIssue[]; warnings: ValidationIssue[] }> {
  const flowId = options.flowId ?? (typeof flow.id === 'string' ? flow.id : '');
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const configs = Array.isArray(flow.configs) ? flow.configs : [];
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (flowId) {
    errors.push(...collectZMismatchIssues(nodes, flowId));
  }
  const wire = await collectWireValidation(nodes, options.nodeTypes);
  errors.push(...wire.errors);
  warnings.push(...wire.warnings);
  if (options.nodeTypes) {
    warnings.push(...(await collectConfigWarnings(nodes, configs, options.nodeTypes)));
  }
  return { errors, warnings };
}
