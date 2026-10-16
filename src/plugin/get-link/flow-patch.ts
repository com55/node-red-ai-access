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
  | { op: 'remove'; nodeId: string }
  | {
      op: 'replace_text';
      nodeId: string;
      field: string;
      find: string;
      replace: string;
      /** 1-based occurrence when `find` matches more than once. */
      occurrence?: number;
    };

/** Identity fields that cannot be changed via set (wires are validated separately). */
const PROTECTED_KEYS = new Set(['id', 'type', 'z']);

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
 * Count non-overlapping occurrences of `find` in `haystack`.
 * Returns start indexes (for applying a single occurrence replace).
 */
export function findTextOccurrences(haystack: string, find: string): number[] {
  if (!find) {
    return [];
  }
  const matches: number[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(find, from);
    if (idx < 0) {
      break;
    }
    matches.push(idx);
    from = idx + find.length;
  }
  return matches;
}

/**
 * Replace one occurrence of `find` inside a string field.
 * `occurrence` is 1-based when the find text is not unique.
 */
export function applyReplaceTextToValue(
  current: unknown,
  field: string,
  find: string,
  replace: string,
  occurrence?: number
): string {
  if (PROTECTED_KEYS.has(field)) {
    throw new AiOpsValidationError(
      `Cannot change protected node property '${field}' via replace_text`,
      'protected_property'
    );
  }
  if (typeof find !== 'string' || find.length === 0) {
    throw new AiOpsValidationError('find must be a non-empty string', 'missing_find');
  }
  if (typeof replace !== 'string') {
    throw new AiOpsValidationError('replace must be a string', 'invalid_replace');
  }
  // Missing field (undefined) → field_not_found; present non-string → field_not_string.
  if (current === undefined) {
    throw new AiOpsValidationError(`Field '${field}' was not found on the node`, 'field_not_found');
  }
  if (typeof current !== 'string') {
    throw new AiOpsValidationError(
      `Field '${field}' is not a string (got ${current === null ? 'null' : typeof current})`,
      'field_not_string'
    );
  }
  const matches = findTextOccurrences(current, find);
  if (matches.length === 0) {
    throw new AiOpsValidationError(`Text not found in field '${field}'`, 'text_not_found', {
      details: { matchCount: 0 },
    });
  }
  let pick = occurrence;
  if (pick === undefined) {
    if (matches.length > 1) {
      throw new AiOpsValidationError(
        `Found ${matches.length} matches in '${field}'; pass occurrence (1-based) to pick one`,
        'ambiguous_match',
        { statusCode: 409, details: { matchCount: matches.length } }
      );
    }
    pick = 1;
  }
  if (!Number.isInteger(pick) || pick < 1 || pick > matches.length) {
    throw new AiOpsValidationError(
      `occurrence must be an integer from 1 to ${matches.length}`,
      'invalid_occurrence',
      { details: { matchCount: matches.length } }
    );
  }
  const at = matches[pick - 1];
  if (at === undefined) {
    throw new AiOpsValidationError(
      `occurrence must be an integer from 1 to ${matches.length}`,
      'invalid_occurrence',
      { details: { matchCount: matches.length } }
    );
  }
  return current.slice(0, at) + replace + current.slice(at + find.length);
}

/**
 * Apply set / add / remove / replace_text ops onto a live flow tab.
 * Multiple ops apply in order (later ops see earlier results).
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
    applyOneNodeOp(nodes, flowId, op);
  }

  assertWireTargetsExist(nodes);
  return { expectedRev: snapshot.rev, flow };
}

function requireNodeIndex(nodes: FlowNode[], nodeId: string, flowId: string): number {
  if (!nodeId || typeof nodeId !== 'string') {
    throw new AiOpsValidationError('Each edit needs a node id', 'missing_node_id');
  }
  const idx = nodes.findIndex(n => n.id === nodeId);
  if (idx < 0 || !nodes[idx]) {
    throw new AiOpsValidationError(
      `Node '${nodeId}' was not found in flow '${flowId}'`,
      'node_not_found',
      { statusCode: 404 }
    );
  }
  return idx;
}

function applyOneNodeOp(nodes: FlowNode[], flowId: string, op: FlowNodeOp): void {
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
    nodes.push({
      ...node,
      id: node.id,
      type: node.type,
      z: typeof node.z === 'string' && node.z ? node.z : flowId,
    });
    return;
  }

  if (op.op === 'remove') {
    const idx = requireNodeIndex(nodes, op.nodeId, flowId);
    nodes.splice(idx, 1);
    return;
  }

  const idx = requireNodeIndex(nodes, op.nodeId, flowId);
  const current = nodes[idx];
  if (!current) {
    throw new AiOpsValidationError(
      `Node '${op.nodeId}' was not found in flow '${flowId}'`,
      'node_not_found',
      { statusCode: 404 }
    );
  }

  if (op.op === 'replace_text') {
    if (!(op.field in current)) {
      throw new AiOpsValidationError(
        `Field '${op.field}' was not found on the node`,
        'field_not_found'
      );
    }
    const nextValue = applyReplaceTextToValue(
      current[op.field],
      op.field,
      op.find,
      op.replace,
      op.occurrence
    );
    nodes[idx] = { ...current, id: current.id, type: current.type, [op.field]: nextValue };
    return;
  }

  const next: FlowNode = { ...current, id: current.id, type: current.type };
  for (const [key, value] of Object.entries(op.set)) {
    if (PROTECTED_KEYS.has(key)) {
      throw new AiOpsValidationError(
        `Cannot change protected node property '${key}' via GET propose`,
        'protected_property'
      );
    }
    if (key === 'wires') {
      assertValidWiresValue(value);
    }
    next[key] = value;
  }
  nodes[idx] = next;
}

function assertValidWiresValue(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new AiOpsValidationError(
      'wires must be an array of output ports (each a list of node ids)',
      'invalid_wires'
    );
  }
  for (const port of value) {
    if (!Array.isArray(port)) {
      throw new AiOpsValidationError(
        'wires must be an array of output ports (each a list of node ids)',
        'invalid_wires'
      );
    }
    for (const target of port) {
      if (typeof target !== 'string' || target.length === 0) {
        throw new AiOpsValidationError(
          'wires targets must be non-empty node id strings',
          'invalid_wires'
        );
      }
    }
  }
}

/** Every wire target must refer to a node present after this patch. */
function assertWireTargetsExist(nodes: FlowNode[]): void {
  const ids = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    if (!('wires' in node)) {
      continue;
    }
    assertValidWiresValue(node.wires);
    const wires = node.wires as unknown[][];
    for (const port of wires) {
      for (const target of port) {
        const id = String(target);
        if (!ids.has(id)) {
          throw new AiOpsValidationError(
            `Wire target '${id}' on node '${node.id}' was not found in this flow (add the node in the same patch or use an existing id)`,
            'invalid_wires'
          );
        }
      }
    }
  }
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

function resolveNodeId(entry: Record<string, unknown>): string {
  if (typeof entry.id === 'string' && entry.id) {
    return entry.id;
  }
  if (typeof entry.nodeId === 'string' && entry.nodeId) {
    return entry.nodeId;
  }
  if (typeof entry.node === 'string' && entry.node) {
    return entry.node;
  }
  return '';
}

function parseOccurrence(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    n = Number(raw);
  } else if (typeof raw === 'boolean' || typeof raw === 'bigint') {
    n = Number(raw);
  } else {
    throw new AiOpsValidationError('occurrence must be a positive integer', 'invalid_occurrence');
  }
  if (!Number.isFinite(n)) {
    throw new AiOpsValidationError('occurrence must be a positive integer', 'invalid_occurrence');
  }
  return Math.trunc(n);
}

function parseAddOp(entry: Record<string, unknown>): FlowNodeOp {
  const nested = entry.node;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return { op: 'add', node: nested as FlowNode };
  }
  const rest: Record<string, unknown> = { ...entry };
  delete rest.op;
  return { op: 'add', node: rest as FlowNode };
}

function parseReplaceTextOp(entry: Record<string, unknown>): FlowNodeOp {
  const nodeId = resolveNodeId(entry);
  if (!nodeId) {
    throw new AiOpsValidationError('replace_text op needs node id', 'missing_node_id');
  }
  const field = typeof entry.field === 'string' ? entry.field : '';
  if (!field) {
    throw new AiOpsValidationError('replace_text op needs field', 'missing_field');
  }
  if (typeof entry.find !== 'string') {
    throw new AiOpsValidationError('replace_text op needs find string', 'missing_find');
  }
  if (typeof entry.replace !== 'string') {
    throw new AiOpsValidationError('replace_text op needs replace string', 'invalid_replace');
  }
  const occurrence = parseOccurrence(entry.occurrence);
  const op: Extract<FlowNodeOp, { op: 'replace_text' }> = {
    op: 'replace_text',
    nodeId,
    field,
    find: entry.find,
    replace: entry.replace,
  };
  if (occurrence !== undefined) {
    op.occurrence = occurrence;
  }
  return op;
}

function parseSetOp(entry: Record<string, unknown>): FlowNodeOp {
  const nodeId = resolveNodeId(entry);
  if (!nodeId) {
    throw new AiOpsValidationError('Each patch.nodes entry needs id', 'missing_node_id');
  }
  const setRaw = entry.set;
  const set: Record<string, unknown> = {};
  if (setRaw && typeof setRaw === 'object' && !Array.isArray(setRaw)) {
    Object.assign(set, setRaw);
  } else {
    for (const [k, v] of Object.entries(entry)) {
      if (k === 'id' || k === 'nodeId' || k === 'node' || k === 'set' || k === 'op') continue;
      set[k] = v;
    }
  }
  return { op: 'set', nodeId, set };
}

function parseNodeOp(entry: Record<string, unknown>): FlowNodeOp {
  const rawOp = typeof entry.op === 'string' ? entry.op.toLowerCase() : 'set';
  if (rawOp === 'add') {
    return parseAddOp(entry);
  }
  if (rawOp === 'remove') {
    const nodeId = resolveNodeId(entry);
    if (!nodeId) {
      throw new AiOpsValidationError('remove op needs id', 'missing_node_id');
    }
    return { op: 'remove', nodeId };
  }
  if (rawOp === 'replace_text') {
    return parseReplaceTextOp(entry);
  }
  if (rawOp !== 'set') {
    throw new AiOpsValidationError(
      "nodes[].op must be 'add', 'remove', 'set', or 'replace_text'",
      'invalid_patch'
    );
  }
  return parseSetOp(entry);
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
 * - `{ "nodes": [ { "op":"replace_text", "node":"n1", "field":"template",
 *     "find":"old", "replace":"new", "occurrence":1 } ] }` (ops apply in order)
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
