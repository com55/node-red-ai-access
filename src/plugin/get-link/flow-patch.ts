/**
 * Apply node-level property edits onto a live flow tab for GET propose / drafts.
 */

import type { FlowAdapter, FlowNode, FlowTab } from '../../runtime/types.js';
import { AiOpsValidationError } from '../ai-ops.js';

export interface NodePropertyEdit {
  nodeId: string;
  set: Record<string, unknown>;
}

/** Node-level ops for patch / mode=json drafts. */
export type FlowNodeOp =
  | { op: 'set'; nodeId: string; set: Record<string, unknown> }
  | { op: 'add'; node: FlowNode }
  | { op: 'remove'; nodeId: string };

const PROTECTED_KEYS = new Set(['id', 'type', 'z', 'wires']);

/**
 * Load a flow, apply property edits to named nodes, return the full tab
 * suitable for a `replace_flow` proposal (approve with deploymentType `nodes`).
 */
export async function buildPatchedFlowTab(
  adapter: FlowAdapter,
  flowId: string,
  edits: NodePropertyEdit[]
): Promise<{ expectedRev: string; flow: FlowTab }> {
  return applyFlowNodeOps(
    adapter,
    flowId,
    edits.map(edit => ({ op: 'set' as const, nodeId: edit.nodeId, set: edit.set }))
  );
}

/**
 * Apply set / add / remove ops onto a live flow tab.
 */
export async function applyFlowNodeOps(
  adapter: FlowAdapter,
  flowId: string,
  ops: FlowNodeOp[]
): Promise<{ expectedRev: string; flow: FlowTab }> {
  if (!flowId) {
    throw new AiOpsValidationError('flow id is required', 'missing_flow_id');
  }
  if (!ops.length) {
    throw new AiOpsValidationError('At least one node edit is required', 'missing_edits');
  }

  const snapshot = await adapter.getFlow(flowId);
  const nodes: FlowNode[] = Array.isArray(snapshot.flow.nodes) ? [...snapshot.flow.nodes] : [];
  const flow: FlowTab = {
    ...snapshot.flow,
    id: snapshot.flow.id,
    type: snapshot.flow.type ?? 'tab',
    nodes,
  };

  for (const op of ops) {
    if (op.op === 'add') {
      const node = op.node;
      if (!node.id || typeof node.id !== 'string') {
        throw new AiOpsValidationError('add op needs node.id', 'missing_node_id');
      }
      if (!node.type || typeof node.type !== 'string') {
        throw new AiOpsValidationError('add op needs node.type', 'missing_node_type');
      }
      if (nodes.some(n => n.id === node.id)) {
        throw new AiOpsValidationError(
          `Node '${node.id}' already exists in flow '${flowId}'`,
          'node_already_exists'
        );
      }
      const next: FlowNode = {
        ...node,
        id: node.id,
        type: node.type,
        z: typeof node.z === 'string' && node.z ? node.z : flowId,
      };
      nodes.push(next);
      continue;
    }

    if (op.op === 'remove') {
      if (!op.nodeId || typeof op.nodeId !== 'string') {
        throw new AiOpsValidationError('remove op needs id', 'missing_node_id');
      }
      const idx = nodes.findIndex(n => n.id === op.nodeId);
      if (idx < 0) {
        throw new AiOpsValidationError(
          `Node '${op.nodeId}' was not found in flow '${flowId}'`,
          'node_not_found'
        );
      }
      nodes.splice(idx, 1);
      continue;
    }

    // set
    if (!op.nodeId || typeof op.nodeId !== 'string') {
      throw new AiOpsValidationError('Each edit needs a node id', 'missing_node_id');
    }
    const idx = nodes.findIndex(n => n.id === op.nodeId);
    if (idx < 0) {
      throw new AiOpsValidationError(
        `Node '${op.nodeId}' was not found in flow '${flowId}'`,
        'node_not_found'
      );
    }
    const current = nodes[idx];
    if (!current) {
      throw new AiOpsValidationError(
        `Node '${op.nodeId}' was not found in flow '${flowId}'`,
        'node_not_found'
      );
    }
    const next: FlowNode = { ...current, id: current.id, type: current.type };
    for (const [key, value] of Object.entries(op.set)) {
      if (PROTECTED_KEYS.has(key)) {
        throw new AiOpsValidationError(
          `Cannot change protected node property '${key}' via GET propose`,
          'protected_property'
        );
      }
      next[key] = value;
    }
    nodes[idx] = next;
  }

  return { expectedRev: snapshot.rev, flow };
}

function stringifyQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}

/** Parse `set.<prop>=` query keys and nested `set` objects. */
export function collectSetProps(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const nested = query.set;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
      const asString = stringifyQueryValue(value);
      if (asString !== undefined) {
        out[key] = asString;
      }
    }
  }
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('set.') || key.length <= 4) {
      continue;
    }
    const prop = key.slice(4);
    if (typeof value === 'string') {
      out[prop] = value;
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      out[prop] = value[0];
    } else {
      const asString = stringifyQueryValue(value);
      if (asString !== undefined) {
        out[prop] = asString;
      }
    }
  }
  return out;
}

export function decodeBase64UrlJson(encoded: string): unknown {
  let jsonText: string;
  try {
    jsonText = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    throw new AiOpsValidationError('patch must be base64url-encoded JSON', 'invalid_patch');
  }
  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    throw new AiOpsValidationError('patch JSON is malformed', 'invalid_patch_json');
  }
}

function resolveReplaceFlowId(
  obj: Record<string, unknown>,
  fallbackFlowId: string | undefined
): string | undefined {
  if (typeof obj.flowId === 'string' && obj.flowId) {
    return obj.flowId;
  }
  const flow = obj.flow;
  if (flow && typeof flow === 'object' && !Array.isArray(flow)) {
    const id = (flow as { id?: unknown }).id;
    if (typeof id === 'string' && id) {
      return id;
    }
  }
  return fallbackFlowId;
}

function parseNodeOp(entry: Record<string, unknown>): FlowNodeOp {
  const rawOp = typeof entry.op === 'string' ? entry.op.toLowerCase() : 'set';

  if (rawOp === 'add') {
    const nested = entry.node;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const node = nested as FlowNode;
      return { op: 'add', node };
    }
    const rest: Record<string, unknown> = { ...entry };
    delete rest.op;
    return { op: 'add', node: rest as FlowNode };
  }

  if (rawOp === 'remove') {
    const nodeId =
      typeof entry.id === 'string'
        ? entry.id
        : typeof entry.nodeId === 'string'
          ? entry.nodeId
          : '';
    if (!nodeId) {
      throw new AiOpsValidationError('remove op needs id', 'missing_node_id');
    }
    return { op: 'remove', nodeId };
  }

  if (rawOp !== 'set') {
    throw new AiOpsValidationError("nodes[].op must be 'add', 'remove', or 'set'", 'invalid_patch');
  }

  const nodeId =
    typeof entry.id === 'string' ? entry.id : typeof entry.nodeId === 'string' ? entry.nodeId : '';
  if (!nodeId) {
    throw new AiOpsValidationError('Each patch.nodes entry needs id', 'missing_node_id');
  }
  const setRaw = entry.set;
  const set: Record<string, unknown> = {};
  if (setRaw && typeof setRaw === 'object' && !Array.isArray(setRaw)) {
    Object.assign(set, setRaw);
  } else {
    for (const [k, v] of Object.entries(entry)) {
      if (k === 'id' || k === 'nodeId' || k === 'set' || k === 'op') continue;
      set[k] = v;
    }
  }
  return { op: 'set', nodeId, set };
}

/** Result of decoding a GET patch / mode=json draft document. */
export type InterpretedPatch =
  | { kind: 'nodes'; flowId: string; ops: FlowNodeOp[]; edits: NodePropertyEdit[] }
  | { kind: 'replace_flow'; flowId: string; flow: FlowTab };

/**
 * Interpret a decoded patch object as either node ops or a full replace_flow tab.
 *
 * Node-level document shapes:
 * - `{ "nodes": [ { "op":"set", "id":"n1", "set":{ "name":"Hi" } }, … ] }`
 * - `{ "nodes": [ { "op":"add", "node":{ "id":"n3", "type":"debug", … } } ] }`
 * - `{ "nodes": [ { "op":"remove", "id":"n2" } ] }`
 * - Legacy set without `op`: `{ "nodes": [ { "id":"n1", "set":{…} } ] }`
 * - Full replace: `{ "type":"replace_flow", "flowId":"tab1", "flow":{…} }`
 */
export function interpretPatch(
  patch: unknown,
  fallbackFlowId: string | undefined
): InterpretedPatch {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new AiOpsValidationError('patch must be a JSON object', 'invalid_patch');
  }
  const obj = patch as Record<string, unknown>;

  if (obj.type === 'replace_flow' || (obj.flow && typeof obj.flow === 'object')) {
    const flowId = resolveReplaceFlowId(obj, fallbackFlowId);
    if (!flowId) {
      throw new AiOpsValidationError('patch.replace_flow needs flowId', 'missing_flow_id');
    }
    return {
      kind: 'replace_flow',
      flowId,
      flow: obj.flow as FlowTab,
    };
  }

  if (Array.isArray(obj.nodes)) {
    const flowId = typeof obj.flowId === 'string' ? obj.flowId : fallbackFlowId;
    if (!flowId) {
      throw new AiOpsValidationError('patch.nodes needs flow id', 'missing_flow_id');
    }
    const ops: FlowNodeOp[] = [];
    for (const entry of obj.nodes) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new AiOpsValidationError('Each patch.nodes entry must be an object', 'invalid_patch');
      }
      ops.push(parseNodeOp(entry as Record<string, unknown>));
    }
    const edits: NodePropertyEdit[] = ops
      .filter((o): o is Extract<FlowNodeOp, { op: 'set' }> => o.op === 'set')
      .map(o => ({ nodeId: o.nodeId, set: o.set }));
    return { kind: 'nodes', flowId, ops, edits };
  }

  throw new AiOpsValidationError(
    'patch must include nodes[] edits or type/flow for replace_flow',
    'invalid_patch'
  );
}
