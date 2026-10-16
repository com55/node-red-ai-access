/**
 * Shared flow / patch validation: wires vs outputs, required config nodes,
 * z mismatch, and multi-error accumulation (`errors: [...]`).
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
  const primary = issues[0]!;
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

export function wireCountIssue(
  node: FlowNode,
  outputs: number,
  wires: unknown[]
): ValidationIssue | undefined {
  const typeName = typeof node.type === 'string' ? node.type : 'node';
  if (wires.length === outputs) {
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
    error: `${typeName} has ${outputs} outputs; wires must be an array of length ${outputs}`,
    nodeId: node.id,
    type: typeName,
  };
}

/** Check wire targets exist and (when known) port count matches outputs. */
export async function collectWireIssues(
  nodes: FlowNode[],
  adapter?: NodeTypesAdapter
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const ids = new Set(nodes.map(n => n.id));

  for (const node of nodes) {
    if (!('wires' in node)) {
      continue;
    }
    if (!assertValidWiresShape(node.wires, issues, node.id)) {
      continue;
    }
    const wires = node.wires as unknown[];
    const outputs = await resolveNodeOutputCount(node, adapter);
    if (outputs !== undefined) {
      const countIssue = wireCountIssue(node, outputs, wires);
      if (countIssue) {
        issues.push(countIssue);
      }
    }
    for (const port of wires) {
      for (const target of port as unknown[]) {
        const id = String(target);
        if (!ids.has(id)) {
          issues.push({
            code: 'invalid_wires',
            error: `Wire target '${id}' on node '${node.id}' was not found in this flow (add the node in the same patch or use an existing id)`,
            nodeId: node.id,
          });
        }
      }
    }
  }
  return issues;
}

export function collectZMismatchIssues(nodes: FlowNode[], flowId: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of nodes) {
    if (node.z === undefined || node.z === null || node.z === '') {
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
 * Ensure required config-node properties reference an existing config of the
 * expected type. Returns hard errors (`missing_config_node`) with candidates.
 */
export async function collectMissingConfigIssues(
  nodes: FlowNode[],
  configs: FlowNode[],
  adapter: NodeTypesAdapter
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
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
      const mustHave = requiredFlag || requiredTypes.has(cfgType);
      const value = node[prop];
      const candidates = configCandidates(allConfigs, cfgType);

      if (typeof value !== 'string' || value.length === 0) {
        if (mustHave) {
          issues.push({
            code: 'missing_config_node',
            error: `Node '${node.id}' (${typeName}) requires a ${cfgType} config on property '${prop}'`,
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
      if (!found || found.type !== cfgType) {
        issues.push({
          code: 'missing_config_node',
          error: `Node '${node.id}' property '${prop}' must reference an existing ${cfgType} config node`,
          nodeId: node.id,
          type: typeName,
          property: prop,
          configType: cfgType,
          candidates,
        });
      }
    }
  }
  return issues;
}

/**
 * Soft warnings for optional config refs (empty but not required).
 * Callers may attach these to successful proposal responses / diffs.
 */
export async function collectConfigWarnings(
  nodes: FlowNode[],
  configs: FlowNode[],
  adapter: NodeTypesAdapter
): Promise<ValidationIssue[]> {
  const warnings: ValidationIssue[] = [];
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
      if (requiredFlag || requiredTypes.has(cfgType)) {
        continue; // those are hard errors, not warnings
      }
      const value = node[prop];
      if (typeof value === 'string' && value.length > 0) {
        continue;
      }
      warnings.push({
        code: 'missing_config_node',
        error: `Node '${node.id}' (${typeName}) has optional ${cfgType} config property '${prop}' unset`,
        nodeId: node.id,
        type: typeName,
        property: prop,
        configType: cfgType,
        candidates: configCandidates(configs, cfgType),
      });
    }
  }
  return warnings;
}

/** Validate a full flow tab (replace_flow): z, wires, required configs. */
export async function validateFlowTab(
  flow: Partial<FlowTab> | FlowTab,
  options: { flowId?: string; nodeTypes?: NodeTypesAdapter } = {}
): Promise<{ errors: ValidationIssue[]; warnings: ValidationIssue[] }> {
  const flowId = options.flowId ?? (typeof flow.id === 'string' ? flow.id : '');
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const configs = Array.isArray(flow.configs) ? flow.configs : [];
  const errors: ValidationIssue[] = [];
  if (flowId) {
    errors.push(...collectZMismatchIssues(nodes, flowId));
  }
  errors.push(...(await collectWireIssues(nodes, options.nodeTypes)));
  const warnings: ValidationIssue[] = [];
  if (options.nodeTypes) {
    errors.push(...(await collectMissingConfigIssues(nodes, configs, options.nodeTypes)));
    warnings.push(...(await collectConfigWarnings(nodes, configs, options.nodeTypes)));
  }
  return { errors, warnings };
}
