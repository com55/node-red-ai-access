/**
 * Apply node-level property edits onto a live flow tab for GET propose / drafts.
 */

import type { FlowAdapter, FlowNode, FlowTab } from '../../runtime/types.js';
import { AiOpsValidationError } from '../ai-ops.js';

export interface NodePropertyEdit {
  nodeId: string;
  set: Record<string, unknown>;
}

/**
 * Load a flow, apply property edits to named nodes, return the full tab
 * suitable for a `replace_flow` proposal (approve with deploymentType `nodes`).
 */
export async function buildPatchedFlowTab(
  adapter: FlowAdapter,
  flowId: string,
  edits: NodePropertyEdit[]
): Promise<{ expectedRev: string; flow: FlowTab }> {
  if (!flowId) {
    throw new AiOpsValidationError('flow id is required', 'missing_flow_id');
  }
  if (!edits.length) {
    throw new AiOpsValidationError('At least one node edit is required', 'missing_edits');
  }

  const snapshot = await adapter.getFlow(flowId);
  const nodes: FlowNode[] = Array.isArray(snapshot.flow.nodes) ? [...snapshot.flow.nodes] : [];
  const flow: FlowTab = {
    ...snapshot.flow,
    id: snapshot.flow.id ?? flowId,
    type: snapshot.flow.type ?? 'tab',
    nodes,
  };

  for (const edit of edits) {
    if (!edit.nodeId || typeof edit.nodeId !== 'string') {
      throw new AiOpsValidationError('Each edit needs a node id', 'missing_node_id');
    }
    const idx = nodes.findIndex(n => n.id === edit.nodeId);
    if (idx < 0) {
      throw new AiOpsValidationError(
        `Node '${edit.nodeId}' was not found in flow '${flowId}'`,
        'node_not_found'
      );
    }
    const current = nodes[idx]!;
    const next: FlowNode = { ...current, id: current.id, type: current.type };
    for (const [key, value] of Object.entries(edit.set)) {
      if (key === 'id' || key === 'type' || key === 'z' || key === 'wires') {
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

/**
 * Interpret a decoded patch object as either node edits or a full replace_flow tab.
 */
export function interpretPatch(
  patch: unknown,
  fallbackFlowId: string | undefined
): {
  kind: 'nodes' | 'replace_flow';
  flowId: string;
  edits?: NodePropertyEdit[];
  flow?: FlowTab;
} {
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
    const edits: NodePropertyEdit[] = [];
    for (const entry of obj.nodes) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new AiOpsValidationError('Each patch.nodes entry must be an object', 'invalid_patch');
      }
      const node = entry as Record<string, unknown>;
      const nodeId = typeof node.id === 'string' ? node.id : undefined;
      if (!nodeId) {
        throw new AiOpsValidationError('Each patch.nodes entry needs id', 'missing_node_id');
      }
      const setRaw = node.set;
      const set: Record<string, unknown> = {};
      if (setRaw && typeof setRaw === 'object' && !Array.isArray(setRaw)) {
        Object.assign(set, setRaw);
      } else {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'id' || k === 'set') continue;
          set[k] = v;
        }
      }
      edits.push({ nodeId, set });
    }
    return { kind: 'nodes', flowId, edits };
  }

  throw new AiOpsValidationError(
    'patch must include nodes[] edits or type/flow for replace_flow',
    'invalid_patch'
  );
}
