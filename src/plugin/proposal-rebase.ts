/**
 * Auto-rebase for pending proposals (3-way merge with strict conflict rules).
 *
 * A proposal stores the tab it was based on (`baseFlow`, B) and the tab it
 * wants (`payload.flow`, P). When the live flows (C) move, we compute what to
 * deploy without overwriting anything the user changed since B:
 *
 * - Node changed only in P → take P. Changed only in C → keep C.
 * - Node changed in both → conflict (strict), except when one side changed only
 *   `x` / `y` (position): then the other side's content wins and the position
 *   edit is kept.
 * - Node deleted live and untouched by P → accept the deletion.
 * - Node deleted live but changed in P, or deleted in P but changed live → conflict.
 * - New node id in P that also exists live (any tab) with different content → conflict.
 * - Tab deleted live → conflict.
 * - A merged node wiring to (or grouped under) a node that no longer exists → conflict.
 * - A `[REDACTED]` placeholder must never reach the deployed tab → conflict.
 *
 * The merge is a pure function of (B, P, C); the proposal body itself is never
 * rewritten by a rebase, so re-running it against a newer live rev is safe.
 */

import { createHash } from 'node:crypto';

import type { FlowNode, FlowTab } from '../runtime/types.js';

import { REDACTED_PLACEHOLDER } from './secret-patterns.js';

export type RebaseState = 'clean' | 'merged' | 'conflict';

export type RebaseConflictKind =
  | 'node_changed_both'
  | 'node_deleted_live'
  | 'node_deleted_in_proposal_modified_live'
  | 'id_collision'
  | 'tab_deleted'
  | 'tab_changed_both'
  | 'base_unavailable'
  | 'dangling_reference'
  | 'redacted_placeholder';

/** How a conflict may be resolved by hand in the dashboard. */
export type ConflictChoice = 'live' | 'proposed';

export interface RebaseConflict {
  kind: RebaseConflictKind;
  /** Node id (or the tab id for tab-level conflicts). */
  nodeId?: string;
  nodeType?: string;
  nodeName?: string;
  /** Field names that differ (no values — those come from the diff view). */
  fields?: string[];
  /** Short human explanation. */
  message: string;
  /** Manual choices the dashboard may offer (empty → AI resubmit or reject only). */
  choices: ConflictChoice[];
}

export interface RebaseResult {
  state: RebaseState;
  /** Live rev the merge was computed against. */
  rev: string;
  conflicts: RebaseConflict[];
  /** Tab to deploy (absent on conflict). */
  merged?: FlowTab;
  /** Short hash of `merged` — the reviewer acknowledges this on approve. */
  mergedHash?: string;
  /** Ids of nodes (or the tab id) that changed live since the base snapshot. */
  liveChangedIds: string[];
}

const TAB_FIELDS = ['label', 'disabled', 'info', 'env'] as const;
const POSITION_FIELDS = new Set(['x', 'y']);
/** Keys never compared (set by the deploy path / runtime). */
const IGNORED_FIELDS = new Set(['z']);
const MAX_CONFLICTS = 200;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function hashTab(tab: Partial<FlowTab>): string {
  return createHash('sha256').update(stableStringify(tab)).digest('hex').slice(0, 16);
}

type NodeMap = Map<string, { node: FlowNode; config: boolean }>;

function asNodes(list: unknown): FlowNode[] {
  return Array.isArray(list)
    ? (list.filter(
        n => n && typeof n === 'object' && typeof (n as FlowNode).id === 'string'
      ) as FlowNode[])
    : [];
}

function mapTab(tab: Partial<FlowTab>): NodeMap {
  const map: NodeMap = new Map();
  for (const node of asNodes(tab.nodes)) map.set(node.id, { node, config: false });
  for (const node of asNodes(tab.configs)) map.set(node.id, { node, config: true });
  return map;
}

function tabProps(tab: Partial<FlowTab> | FlowNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TAB_FIELDS) {
    if ((tab as Record<string, unknown>)[key] !== undefined) {
      out[key] = (tab as Record<string, unknown>)[key];
    }
  }
  return out;
}

/** Field names whose values differ between two node objects. */
export function changedFields(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined
): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const out: string[] = [];
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    if (stableStringify(a?.[key]) !== stableStringify(b?.[key])) out.push(key);
  }
  return out.sort();
}

function positionOnly(fields: string[]): boolean {
  return fields.length > 0 && fields.every(f => POSITION_FIELDS.has(f));
}

function withPosition(target: FlowNode, from: FlowNode): FlowNode {
  const out: FlowNode = { ...target };
  for (const key of POSITION_FIELDS) {
    if (from[key] === undefined) delete out[key];
    else out[key] = from[key];
  }
  return out;
}

function nodeLabel(node: FlowNode | undefined): { nodeType?: string; nodeName?: string } {
  if (!node) return {};
  const out: { nodeType?: string; nodeName?: string } = {};
  if (typeof node.type === 'string') out.nodeType = node.type;
  if (typeof node.name === 'string' && node.name) out.nodeName = node.name.slice(0, 120);
  return out;
}

/** Nested current tab from the flat live flows array (undefined when missing). */
export function liveTabFromFlows(
  flows: readonly FlowNode[],
  flowId: string
): { tab: FlowNode; nodes: FlowNode[] } | undefined {
  const tab = flows.find(n => n.id === flowId && (n.type === 'tab' || n.type === 'subflow'));
  if (!tab) return undefined;
  return { tab, nodes: flows.filter(n => n.id !== flowId && n.z === flowId) };
}

/** Build a nested FlowTab (nodes + configs) from the flat live flows. */
export function nestedLiveTab(
  flows: readonly FlowNode[],
  flowId: string,
  hint?: Partial<FlowTab>
): FlowTab | undefined {
  const live = liveTabFromFlows(flows, flowId);
  if (!live) return undefined;
  const hintConfigs = new Set(asNodes(hint?.configs).map(n => n.id));
  const hintNodes = new Set(asNodes(hint?.nodes).map(n => n.id));
  const nodes: FlowNode[] = [];
  const configs: FlowNode[] = [];
  for (const node of live.nodes) {
    const isConfig = hintConfigs.has(node.id)
      ? true
      : hintNodes.has(node.id)
        ? false
        : node.x === undefined && node.y === undefined && node.wires === undefined;
    (isConfig ? configs : nodes).push(node);
  }
  const out: FlowTab = { id: flowId, type: live.tab.type, ...tabProps(live.tab), nodes };
  if (configs.length > 0) out.configs = configs;
  return out;
}

function containsPlaceholder(value: unknown, depth = 0): boolean {
  if (depth > 40) return false;
  if (typeof value === 'string') return value.includes(REDACTED_PLACEHOLDER);
  if (Array.isArray(value)) return value.some(v => containsPlaceholder(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(v =>
      containsPlaceholder(v, depth + 1)
    );
  }
  return false;
}

export interface RebaseInput {
  flowId: string;
  /** Tab snapshot the proposal was based on (undefined on legacy records). */
  base: Partial<FlowTab> | undefined;
  /** Proposal's intended tab. */
  proposed: Partial<FlowTab>;
  /** Live flows (flat) and rev. */
  liveFlows: readonly FlowNode[];
  liveRev: string;
  /** Proposal's base rev (when equal to liveRev the proposal is trivially clean). */
  baseRev?: string;
}

/** Compute the 3-way rebase of a proposal onto the live flows. */
export function rebaseFlowTab(input: RebaseInput): RebaseResult {
  const { flowId, proposed, liveFlows, liveRev } = input;
  const conflicts: RebaseConflict[] = [];
  const push = (c: RebaseConflict) => {
    if (conflicts.length < MAX_CONFLICTS) conflicts.push(c);
  };

  const live = liveTabFromFlows(liveFlows, flowId);
  if (!live) {
    push({
      kind: 'tab_deleted',
      nodeId: flowId,
      message: 'The flow tab this proposal edits was deleted in the editor.',
      choices: [],
    });
    return { state: 'conflict', rev: liveRev, conflicts, liveChangedIds: [flowId] };
  }

  const base = input.base;
  if (base === undefined) {
    if (input.baseRev !== undefined && input.baseRev === liveRev) {
      return finish(proposed, proposed, liveRev, [], []);
    }
    push({
      kind: 'base_unavailable',
      nodeId: flowId,
      message:
        'This proposal was stored before base snapshots existed and the flows changed since, ' +
        'so live edits cannot be told apart from the proposal. Ask the AI to resubmit, ' +
        'or apply the proposal over the live tab.',
      choices: ['proposed'],
    });
    return { state: 'conflict', rev: liveRev, conflicts, liveChangedIds: [] };
  }

  const current = nestedLiveTab(liveFlows, flowId, proposed)!;
  const B = mapTab(base);
  const C = mapTab(current);
  const P = mapTab(proposed);
  const liveChangedIds: string[] = [];

  // --- Tab-level props ---------------------------------------------------
  const bTab = tabProps(base);
  const cTab = tabProps(live.tab);
  const pTab = tabProps(proposed);
  const tabLive = changedFields(bTab, cTab);
  const tabProp = changedFields(bTab, pTab);
  let mergedTabProps = pTab;
  if (tabLive.length > 0) {
    liveChangedIds.push(flowId);
    if (tabProp.length === 0) {
      mergedTabProps = cTab;
    } else if (stableStringify(cTab) !== stableStringify(pTab)) {
      push({
        kind: 'tab_changed_both',
        nodeId: flowId,
        fields: [...new Set([...tabLive, ...tabProp])].sort(),
        message: 'Both the editor and the proposal changed the flow tab settings.',
        choices: ['live', 'proposed'],
      });
    }
  }

  // --- Nodes -------------------------------------------------------------
  const resolved = new Map<string, { node: FlowNode; config: boolean } | null>();
  const allIds = new Set<string>([...B.keys(), ...C.keys(), ...P.keys()]);
  const otherTabIds = new Map<string, FlowNode>();
  for (const node of liveFlows) {
    if (node.id !== flowId && node.z !== flowId) otherTabIds.set(node.id, node);
  }

  for (const id of allIds) {
    const b = B.get(id);
    const c = C.get(id);
    const p = P.get(id);
    const dC = b && c ? changedFields(b.node, c.node) : [];
    const dP = b && p ? changedFields(b.node, p.node) : [];
    if (b && (!c || dC.length > 0)) liveChangedIds.push(id);
    else if (!b && c) liveChangedIds.push(id);

    if (b && c && p) {
      if (dP.length === 0) resolved.set(id, c);
      else if (dC.length === 0) resolved.set(id, p);
      else if (stableStringify(withoutZ(c.node)) === stableStringify(withoutZ(p.node)))
        resolved.set(id, c);
      else if (positionOnly(dC)) resolved.set(id, { ...p, node: withPosition(p.node, c.node) });
      else if (positionOnly(dP)) resolved.set(id, { ...c, node: withPosition(c.node, p.node) });
      else {
        push({
          kind: 'node_changed_both',
          nodeId: id,
          ...nodeLabel(c.node),
          fields: [...new Set([...dC, ...dP])].filter(f => !POSITION_FIELDS.has(f)).sort(),
          message: 'Both the editor and the proposal changed this node.',
          choices: ['live', 'proposed'],
        });
      }
    } else if (b && c && !p) {
      // Proposal deletes it.
      if (dC.length === 0 || positionOnly(dC)) resolved.set(id, null);
      else
        push({
          kind: 'node_deleted_in_proposal_modified_live',
          nodeId: id,
          ...nodeLabel(c.node),
          fields: dC,
          message: 'The proposal deletes this node, but it was changed in the editor.',
          choices: ['live', 'proposed'],
        });
    } else if (b && !c && p) {
      // Deleted live.
      if (dP.length === 0) resolved.set(id, null);
      else
        push({
          kind: 'node_deleted_live',
          nodeId: id,
          ...nodeLabel(p.node),
          fields: dP,
          message: 'This node was deleted in the editor, but the proposal changes it.',
          choices: ['live', 'proposed'],
        });
    } else if (b && !c && !p) {
      resolved.set(id, null);
    } else if (!b && c && p) {
      if (stableStringify(withoutZ(c.node)) === stableStringify(withoutZ(p.node)))
        resolved.set(id, c);
      else
        push({
          kind: 'id_collision',
          nodeId: id,
          ...nodeLabel(p.node),
          fields: changedFields(c.node, p.node),
          message: 'The proposal adds a node whose id was also added in the editor.',
          choices: ['live', 'proposed'],
        });
    } else if (!b && c && !p) {
      resolved.set(id, c);
    } else if (!b && !c && p) {
      const elsewhere = otherTabIds.get(id);
      if (elsewhere) {
        push({
          kind: 'id_collision',
          nodeId: id,
          ...nodeLabel(p.node),
          message: 'The proposal adds a node whose id now exists on another flow tab.',
          choices: ['live'],
        });
      } else {
        resolved.set(id, p);
      }
    }
  }

  if (conflicts.length > 0) {
    return { state: 'conflict', rev: liveRev, conflicts, liveChangedIds: dedupe(liveChangedIds) };
  }

  // --- Assemble merged tab (proposal order first, then live-only additions) --
  const nodes: FlowNode[] = [];
  const configs: FlowNode[] = [];
  const emitted = new Set<string>();
  const emit = (id: string) => {
    if (emitted.has(id)) return;
    const r = resolved.get(id);
    emitted.add(id);
    if (!r) return;
    (r.config ? configs : nodes).push(withoutZ(r.node));
  };
  for (const node of asNodes(proposed.nodes)) emit(node.id);
  for (const node of asNodes(proposed.configs)) emit(node.id);
  for (const node of asNodes(current.nodes)) emit(node.id);
  for (const node of asNodes(current.configs)) emit(node.id);

  const merged: FlowTab = {
    id: flowId,
    type: typeof proposed.type === 'string' ? proposed.type : (live.tab.type),
    ...mergedTabProps,
    nodes,
  };
  if (configs.length > 0 || Array.isArray(proposed.configs)) merged.configs = configs;

  // --- Post-merge safety checks -----------------------------------------
  const mergedIds = new Set([...nodes, ...configs].map(n => n.id));
  const allLive = new Set(liveFlows.map(n => n.id));
  for (const node of [...nodes, ...configs]) {
    const missing: string[] = [];
    if (Array.isArray(node.wires)) {
      for (const port of node.wires as unknown[]) {
        if (!Array.isArray(port)) continue;
        for (const target of port) {
          if (typeof target === 'string' && !mergedIds.has(target)) missing.push(target);
        }
      }
    }
    if (typeof node.g === 'string' && !mergedIds.has(node.g)) missing.push(node.g);
    if (Array.isArray(node.links)) {
      for (const target of node.links as unknown[]) {
        if (typeof target === 'string' && !mergedIds.has(target) && !allLive.has(target))
          missing.push(target);
      }
    }
    // Only refs the merge broke: targets that existed in the base or the
    // proposal but are gone now (pre-existing dangling refs are left alone).
    const broken = [...new Set(missing)].filter(m => B.has(m) || P.has(m)).sort();
    if (broken.length > 0) {
      push({
        kind: 'dangling_reference',
        nodeId: node.id,
        ...nodeLabel(node),
        fields: broken,
        message:
          'After merging, this node points to a node that no longer exists (deleted in the editor).',
        choices: ['live'],
      });
    }
    if (containsPlaceholder(node)) {
      push({
        kind: 'redacted_placeholder',
        nodeId: node.id,
        ...nodeLabel(node),
        message:
          'A [REDACTED] placeholder would be deployed over a real value. Ask the AI to resubmit.',
        choices: [],
      });
    }
  }
  if (containsPlaceholder(mergedTabProps)) {
    push({
      kind: 'redacted_placeholder',
      nodeId: flowId,
      message:
        'A [REDACTED] placeholder would be deployed into the tab settings. Ask the AI to resubmit.',
      choices: [],
    });
  }
  if (conflicts.length > 0) {
    return { state: 'conflict', rev: liveRev, conflicts, liveChangedIds: dedupe(liveChangedIds) };
  }
  return finish(merged, proposed, liveRev, [], dedupe(liveChangedIds));
}

function finish(
  merged: Partial<FlowTab>,
  proposed: Partial<FlowTab>,
  rev: string,
  conflicts: RebaseConflict[],
  liveChangedIds: string[]
): RebaseResult {
  const mergedHash = hashTab(normalizeForHash(merged));
  const clean = mergedHash === hashTab(normalizeForHash(proposed));
  return {
    state: clean ? 'clean' : 'merged',
    rev,
    conflicts,
    merged: merged as FlowTab,
    mergedHash,
    liveChangedIds,
  };
}

/** Hash input independent of nodes/configs ordering and `z`. */
function normalizeForHash(tab: Partial<FlowTab>): Record<string, unknown> {
  const all = [...asNodes(tab.nodes), ...asNodes(tab.configs)]
    .map(withoutZ)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...tabProps(tab), nodes: all };
}

function withoutZ(node: FlowNode): FlowNode {
  if (!('z' in node)) return node;
  const copy = { ...node };
  delete copy.z;
  return copy;
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Apply a manual per-conflict choice by moving the base (and, for `live`,
 * the proposal) to the live version of that node. Returns new base/proposed tabs.
 */
export function applyConflictChoice(input: {
  flowId: string;
  base: Partial<FlowTab> | undefined;
  proposed: Partial<FlowTab>;
  liveFlows: readonly FlowNode[];
  nodeId: string;
  choice: ConflictChoice;
}): { base: Partial<FlowTab>; proposed: Partial<FlowTab> } {
  const { flowId, nodeId, choice, liveFlows } = input;
  const current = nestedLiveTab(liveFlows, flowId, input.proposed);
  if (!current) throw new Error('flow tab deleted');
  if (input.base === undefined) {
    if (choice !== 'proposed') throw new Error('invalid choice');
    // Apply the proposal as-is over the current tab.
    return { base: clone(current), proposed: clone(input.proposed) };
  }
  const base = clone(input.base);
  const proposed = clone(input.proposed);
  if (nodeId === flowId) {
    const live = tabProps(current);
    for (const key of TAB_FIELDS) {
      delete (base as Record<string, unknown>)[key];
      if (live[key] !== undefined) (base as Record<string, unknown>)[key] = clone(live[key]);
      if (choice === 'live') {
        delete (proposed as Record<string, unknown>)[key];
        if (live[key] !== undefined) (proposed as Record<string, unknown>)[key] = clone(live[key]);
      }
    }
    return { base, proposed };
  }
  const liveMap = mapTab(current);
  const liveNode = liveMap.get(nodeId);
  setNode(base, nodeId, liveNode ? { ...liveNode, node: clone(liveNode.node) } : undefined);
  if (choice === 'live') {
    setNode(proposed, nodeId, liveNode ? { ...liveNode, node: clone(liveNode.node) } : undefined);
  }
  return { base, proposed };
}

function setNode(
  tab: Partial<FlowTab>,
  id: string,
  value: { node: FlowNode; config: boolean } | undefined
): void {
  const nodes = asNodes(tab.nodes);
  const configs = asNodes(tab.configs);
  const inConfigs = configs.some(n => n.id === id);
  const inNodes = nodes.some(n => n.id === id);
  tab.nodes = nodes.filter(n => n.id !== id);
  if (Array.isArray(tab.configs)) tab.configs = configs.filter(n => n.id !== id);
  if (!value) return;
  const asConfig = inConfigs || (!inNodes && value.config);
  if (asConfig) {
    tab.configs = [...asNodes(tab.configs), value.node];
  } else {
    tab.nodes = [...tab.nodes, value.node];
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
