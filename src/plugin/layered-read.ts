/**
 * Layered read helpers: flow summary, one node, field line range, text search.
 * Used by GET link, REST, and MCP (same auth/rate limits as other reads).
 */

import type { FlowAdapter, FlowNode, FlowTab } from '../runtime/types.js';

import { AiOpsValidationError, getFlow, listFlows } from './ai-ops.js';

/** Default max search hits before `truncated: true`. */
export const DEFAULT_SEARCH_RESULT_CAP = 50;

/** Snippet radius (chars) around a search match. */
const SEARCH_SNIPPET_RADIUS = 40;

export interface FlowNodeSummary {
  id: string;
  type: string;
  name?: string;
  wires?: unknown;
  /** UTF-8 byte size of the full node JSON (for sizing reads). */
  bytes: number;
}

export interface FlowSummaryResult {
  rev: string;
  flowId: string;
  label?: string;
  type?: string;
  nodes: FlowNodeSummary[];
  nodeCount: number;
}

export interface GetNodeResult {
  rev: string;
  flowId: string | null;
  node: FlowNode;
}

export interface GetNodeFieldResult {
  rev: string;
  flowId: string | null;
  nodeId: string;
  field: string;
  value: string;
  totalLines: number;
  bytes: number;
  /** Present when `lines=A-B` was requested. */
  lineRange?: { start: number; end: number };
}

export interface SearchHit {
  flowId: string | null;
  nodeId: string;
  field: string;
  /** 1-based line numbers that contain the match. */
  lines: number[];
  snippet: string;
}

export interface SearchResult {
  rev: string;
  q: string;
  flowId?: string;
  hits: SearchHit[];
  hitCount: number;
  truncated: boolean;
  cap: number;
}

function nodeBytes(node: FlowNode): number {
  return Buffer.byteLength(JSON.stringify(node), 'utf8');
}

function summarizeNode(node: FlowNode): FlowNodeSummary {
  const out: FlowNodeSummary = {
    id: node.id,
    type: node.type,
    bytes: nodeBytes(node),
  };
  if (typeof node.name === 'string') {
    out.name = node.name;
  }
  if ('wires' in node) {
    out.wires = node.wires;
  }
  return out;
}

/** `flows/<id>?summary=1` — id/type/name/wires + bytes, no field contents. */
export async function getFlowSummary(
  adapter: FlowAdapter,
  flowId: string
): Promise<FlowSummaryResult> {
  const { rev, flow } = await getFlow(adapter, flowId);
  const tab = flow as FlowTab;
  const nodes = Array.isArray(tab.nodes) ? tab.nodes.map(summarizeNode) : [];
  const result: FlowSummaryResult = {
    rev,
    flowId: tab.id || flowId,
    nodes,
    nodeCount: nodes.length,
  };
  if (typeof tab.label === 'string') {
    result.label = tab.label;
  }
  if (typeof tab.type === 'string') {
    result.type = tab.type;
  }
  return result;
}

function collectTabs(flows: unknown[]): FlowTab[] {
  const tabs: FlowTab[] = [];
  for (const entry of flows) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const f = entry as FlowTab;
    if (f.type === 'tab' || f.type === 'subflow' || Array.isArray(f.nodes)) {
      tabs.push(f);
    }
  }
  return tabs;
}

/**
 * Find a node across flat flows (or one tab). Returns owning flowId from `z`
 * when present, else the tab id that contained it.
 */
export async function findNodeInFlows(
  adapter: FlowAdapter,
  nodeId: string,
  flowId?: string
): Promise<{ rev: string; flowId: string | null; node: FlowNode }> {
  if (!nodeId) {
    throw new AiOpsValidationError('Missing node id', 'missing_node_id');
  }
  if (flowId) {
    const { rev, flow } = await getFlow(adapter, flowId);
    const tab = flow as FlowTab;
    const nodes = Array.isArray(tab.nodes) ? tab.nodes : [];
    const configs = Array.isArray(tab.configs) ? tab.configs : [];
    const node = [...nodes, ...configs].find(n => n.id === nodeId);
    if (!node) {
      throw new AiOpsValidationError(
        `Node '${nodeId}' was not found in flow '${flowId}'`,
        'node_not_found'
      );
    }
    return { rev, flowId, node };
  }

  const { rev, flows } = await listFlows(adapter);
  // Flat Admin API v2 list: tabs and child nodes mixed.
  let found: FlowNode | undefined;
  let owner: string | null = null;
  for (const entry of flows) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const n = entry as FlowNode;
    if (n.id === nodeId && typeof n.type === 'string' && n.type !== 'tab' && n.type !== 'subflow') {
      found = n;
      owner = typeof n.z === 'string' && n.z ? n.z : null;
      break;
    }
  }
  if (!found) {
    // Nested getFlow tabs (test adapters often only nest nodes).
    for (const tab of collectTabs(flows)) {
      const id = tab.id;
      if (!id) continue;
      try {
        const nested = await getFlow(adapter, id);
        const t = nested.flow as FlowTab;
        const pool = [...(t.nodes ?? []), ...(t.configs ?? [])];
        const node = pool.find(n => n.id === nodeId);
        if (node) {
          found = node;
          owner = id;
          break;
        }
      } catch {
        // skip missing tabs
      }
    }
  }
  if (!found) {
    throw new AiOpsValidationError(`Node '${nodeId}' was not found`, 'node_not_found');
  }
  return { rev, flowId: owner, node: found };
}

export async function getNodeById(
  adapter: FlowAdapter,
  nodeId: string,
  flowId?: string
): Promise<GetNodeResult> {
  const found = await findNodeInFlows(adapter, nodeId, flowId);
  return { rev: found.rev, flowId: found.flowId, node: found.node };
}

/** Parse `lines=A-B` or `lines=A` (1-based, inclusive). */
export function parseLineRange(
  raw: string | undefined
): { start: number; end: number } | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const m = /^(\d+)(?:-(\d+))?$/.exec(raw.trim());
  if (!m) {
    throw new AiOpsValidationError(
      'lines must be A or A-B (1-based inclusive)',
      'invalid_line_range'
    );
  }
  const start = Number(m[1]);
  const end = m[2] !== undefined ? Number(m[2]) : start;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new AiOpsValidationError(
      'lines must be A or A-B (1-based inclusive)',
      'invalid_line_range'
    );
  }
  return { start, end };
}

export async function getNodeField(
  adapter: FlowAdapter,
  nodeId: string,
  field: string,
  options: { flowId?: string; lines?: string } = {}
): Promise<GetNodeFieldResult> {
  if (!field) {
    throw new AiOpsValidationError('Missing field name', 'missing_field');
  }
  const found = await findNodeInFlows(adapter, nodeId, options.flowId);
  if (!(field in found.node)) {
    throw new AiOpsValidationError(
      `Field '${field}' was not found on node '${nodeId}'`,
      'field_not_found'
    );
  }
  const raw = found.node[field];
  if (typeof raw !== 'string') {
    throw new AiOpsValidationError(`Field '${field}' is not a string`, 'field_not_string');
  }
  const allLines = raw.split('\n');
  const totalLines = allLines.length;
  const bytes = Buffer.byteLength(raw, 'utf8');
  const range = parseLineRange(options.lines);
  if (!range) {
    return {
      rev: found.rev,
      flowId: found.flowId,
      nodeId,
      field,
      value: raw,
      totalLines,
      bytes,
    };
  }
  const startIdx = Math.min(range.start - 1, allLines.length);
  const endIdx = Math.min(range.end, allLines.length);
  const sliced = allLines.slice(startIdx, endIdx).join('\n');
  return {
    rev: found.rev,
    flowId: found.flowId,
    nodeId,
    field,
    value: sliced,
    totalLines,
    bytes,
    lineRange: { start: range.start, end: Math.min(range.end, totalLines) },
  };
}

function stringFields(node: FlowNode): { field: string; value: string }[] {
  const out: { field: string; value: string }[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'id' || key === 'type' || key === 'z' || key === 'wires') continue;
    if (typeof value === 'string' && value.length > 0) {
      out.push({ field: key, value });
    }
  }
  return out;
}

function snippetAround(value: string, index: number, findLen: number): string {
  const start = Math.max(0, index - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(value.length, index + findLen + SEARCH_SNIPPET_RADIUS);
  let s = value.slice(start, end).replace(/\s+/g, ' ');
  if (start > 0) s = `…${s}`;
  if (end < value.length) s = `${s}…`;
  return s;
}

function searchInNode(
  node: FlowNode,
  flowId: string | null,
  q: string,
  hits: SearchHit[],
  cap: number
): boolean {
  for (const { field, value } of stringFields(node)) {
    if (hits.length >= cap) return true;
    const lines: number[] = [];
    let firstIdx = -1;
    const parts = value.split('\n');
    for (let i = 0; i < parts.length; i += 1) {
      const line = parts[i] ?? '';
      const at = line.indexOf(q);
      if (at >= 0) {
        lines.push(i + 1);
        if (firstIdx < 0) {
          // Absolute index in full value for snippet.
          let offset = 0;
          for (let j = 0; j < i; j += 1) {
            offset += (parts[j]?.length ?? 0) + 1;
          }
          firstIdx = offset + at;
        }
      }
    }
    if (lines.length === 0) continue;
    hits.push({
      flowId,
      nodeId: node.id,
      field,
      lines,
      snippet: snippetAround(value, Math.max(0, firstIdx), q.length),
    });
  }
  return hits.length >= cap;
}

function nodePool(tab: FlowTab): FlowNode[] {
  return [...(tab.nodes ?? []), ...(tab.configs ?? [])];
}

async function searchOneFlow(
  adapter: FlowAdapter,
  flowId: string,
  q: string,
  hits: SearchHit[],
  cap: number
): Promise<{ rev: string; truncated: boolean }> {
  const snapshot = await getFlow(adapter, flowId);
  for (const node of nodePool(snapshot.flow as FlowTab)) {
    if (searchInNode(node, flowId, q, hits, cap)) {
      return { rev: snapshot.rev, truncated: true };
    }
  }
  return { rev: snapshot.rev, truncated: false };
}

async function searchAllFlows(
  adapter: FlowAdapter,
  q: string,
  hits: SearchHit[],
  cap: number
): Promise<{ rev: string; truncated: boolean }> {
  const listed = await listFlows(adapter);
  const seen = new Set<string>();
  for (const tab of collectTabs(listed.flows)) {
    if (!tab.id) continue;
    try {
      const nested = await getFlow(adapter, tab.id);
      for (const node of nodePool(nested.flow as FlowTab)) {
        seen.add(node.id);
        if (searchInNode(node, tab.id, q, hits, cap)) {
          return { rev: listed.rev, truncated: true };
        }
      }
    } catch {
      // ignore missing tabs
    }
  }
  for (const entry of listed.flows) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const n = entry as FlowNode;
    if (!n.id || seen.has(n.id)) continue;
    if (n.type === 'tab' || n.type === 'subflow') continue;
    const owner = typeof n.z === 'string' ? n.z : null;
    if (searchInNode(n, owner, q, hits, cap)) {
      return { rev: listed.rev, truncated: true };
    }
  }
  return { rev: listed.rev, truncated: false };
}

/** Text search across string fields; optional flow scope. */
export async function searchFlows(
  adapter: FlowAdapter,
  q: string,
  options: { flowId?: string; cap?: number } = {}
): Promise<SearchResult> {
  if (!q || typeof q !== 'string') {
    throw new AiOpsValidationError('q query parameter is required', 'missing_query');
  }
  const cap =
    typeof options.cap === 'number' && options.cap > 0
      ? Math.floor(options.cap)
      : DEFAULT_SEARCH_RESULT_CAP;
  const hits: SearchHit[] = [];
  const found = options.flowId
    ? await searchOneFlow(adapter, options.flowId, q, hits, cap)
    : await searchAllFlows(adapter, q, hits, cap);

  const result: SearchResult = {
    rev: found.rev,
    q,
    hits,
    hitCount: hits.length,
    truncated: found.truncated,
    cap,
  };
  if (options.flowId) {
    result.flowId = options.flowId;
  }
  return result;
}

/** Truthy query flag helper (`summary=1`, `summary=true`). */
export function isTruthyQueryFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
