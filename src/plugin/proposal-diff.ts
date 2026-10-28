/**
 * Build a human-readable proposal diff for the /ai-access dashboard.
 *
 * Primary compare is proposal.payload.flow vs the stored baseFlow snapshot
 * (captured at submit). Live flow is only used for the stale-rev warning and
 * an optional secondary "vs current" section for pending proposals.
 */

import { FlowNotFoundError } from '../runtime/errors.js';
import type { FlowAdapter, FlowNode, FlowTab } from '../runtime/types.js';
import { isOpenProposalStatus, type Proposal } from '../storage/proposals.js';

import { diffLines, type LineDiffEntry } from './line-diff.js';
import { nodeTypeText } from './proposal-present.js';
import { nestedLiveTab, type RebaseResult } from './proposal-rebase.js';
import { rebaseProposal } from './proposal-sync.js';
import {
  rawFlowAdapter,
  redactConflictLabels,
  redactFlowData,
  redactProposalForAi,
} from './secret-redaction.js';

/** Node property keys treated as multi-line text for line diffs. */
const TEXT_PROPERTY_KEYS = new Set([
  'func',
  'template',
  'info',
  'payload',
  'code',
  'text',
  'format',
  'syntax',
]);

/** Keys ignored in modified-node compares (layout / wiring noise). */
const IGNORE_COMPARE_KEYS = new Set(['x', 'y', 'w', 'h', 'wires', 'g']);

/** Keys omitted from added/removed property dumps (keep x/y/wires visible). */
const IGNORE_PRESENCE_KEYS = new Set(['w', 'h', 'g']);

export interface ScalarPropertyChange {
  key: string;
  kind: 'scalar';
  before: unknown;
  after: unknown;
}

export interface TextPropertyChange {
  key: string;
  kind: 'text';
  /**
   * Full before text. Present for `format=full`; omitted from `format=summary`
   * responses (use `lines` + `beforeBytes` instead).
   */
  before?: string;
  /**
   * Full after text. Present for `format=full`; omitted from `format=summary`
   * responses (use `lines` + `afterBytes` instead).
   */
  after?: string;
  lines: LineDiffEntry[];
  /** UTF-8 byte length of before (set by diff formatter). */
  beforeBytes?: number;
  /** UTF-8 byte length of after (set by diff formatter). */
  afterBytes?: number;
  /** True when equal runs were collapsed in summary format. */
  truncated?: boolean;
}

export type PropertyChange = ScalarPropertyChange | TextPropertyChange;

export interface ModifiedNodeDiff {
  id: string;
  type: string;
  name?: string;
  /** Human sentence, e.g. Changes template node "Tpl" in "Test Flow" (2 fields). */
  summary: string;
  changes: PropertyChange[];
}

/** Scalar or long-text property on an added/removed node (single-sided). */
export interface PresenceProperty {
  key: string;
  kind: 'scalar' | 'text';
  value: unknown;
  /** When set, UI may offer a sandboxed HTML preview alongside the code. */
  preview?: 'html';
}

/**
 * Added or removed node as one block: summary sentence + key fields + full
 * property list (for “All properties”).
 */
export interface PresenceNodeDiff {
  id: string;
  type: string;
  name?: string;
  /** Human sentence, e.g. Adds template node "demo-html" to flow "Test Flow". */
  summary: string;
  /** Highlighted fields (name, wires by node name, code/HTML). */
  keyFields: PresenceProperty[];
  /** Full property list (technical dump under “All properties”). */
  properties: PresenceProperty[];
}

export interface DiffSectionSummary {
  added: number;
  removed: number;
  modified: number;
  tabChanges: string[];
  /** Node count in the before snapshot (for delete-ratio warnings). */
  beforeNodeCount: number;
  /** Node count in the after/proposed snapshot. */
  afterNodeCount: number;
}

export interface DiffSections {
  tabProperties?: ScalarPropertyChange[];
  summary: DiffSectionSummary;
  added: PresenceNodeDiff[];
  removed: PresenceNodeDiff[];
  modified: ModifiedNodeDiff[];
  /** Soft validation notes (e.g. optional unset config refs). */
  warnings?: { code: string; error: string; [key: string]: unknown }[];
}

export interface ProposalDiffResult extends DiffSections {
  proposalId: string;
  flowId: string;
  expectedRev: string;
  baseRev: string;
  currentRev: string;
  /**
   * True only for **open** proposals when expectedRev !== live rev
   * (informational). Never true for approved/rejected/failed.
   */
  baseRevChanged: boolean;
  /** What the primary sections were compared against. */
  compareAgainst: 'base' | 'current';
  /** True when the proposal has no stored baseFlow (legacy). */
  baseSnapshotMissing?: boolean;
  /**
   * When pending + baseRevChanged and a base snapshot exists: proposal vs live
   * flow (what would apply / conflict with the current editor state).
   */
  vsCurrent?: DiffSections;
  liveChanges?: DiffSections;
  /** Values for the conflicting paths, using the same redacted view as this diff. */
  conflictValues?: {
    nodeId: string;
    fields: { field: string; base?: unknown; live?: unknown; proposed?: unknown }[];
  }[];
  /** Live editor values the AI chose to replace, and the reviewed deploy values. */
  aiOverrideValues?: ProposalDiffResult['conflictValues'];
  rebase?: Pick<RebaseResult, 'state' | 'rev' | 'mergedHash' | 'conflicts'>;
  /** Diff payload format (`summary` default collapses unchanged runs). */
  format?: 'summary' | 'full';
}

function nodeName(node: FlowNode): string | undefined {
  if (typeof node.name === 'string' && node.name.length > 0) {
    return node.name;
  }
  if (typeof node.label === 'string' && node.label.length > 0) {
    return node.label;
  }
  return undefined;
}

function collectNodes(flow: Partial<FlowTab>): Map<string, FlowNode> {
  const map = new Map<string, FlowNode>();
  for (const node of flow.nodes ?? []) {
    map.set(node.id, node);
  }
  for (const node of flow.configs ?? []) {
    map.set(node.id, node);
  }
  return map;
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

function looksLikeHtml(text: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(text.slice(0, 800));
}

function isHtmlTemplateField(node: FlowNode, key: string, text: string): boolean {
  if (key !== 'template') {
    return false;
  }
  const format = typeof node.format === 'string' ? node.format.toLowerCase() : '';
  if (format === 'html' || format === 'handlebars' || format === 'mustache') {
    return true;
  }
  return looksLikeHtml(text);
}

function toPresenceProperty(node: FlowNode, key: string, value: unknown): PresenceProperty {
  const text = asText(value);
  if (TEXT_PROPERTY_KEYS.has(key) && text !== null) {
    const prop: PresenceProperty = { key, kind: 'text', value: text };
    if (isHtmlTemplateField(node, key, text)) {
      prop.preview = 'html';
    }
    return prop;
  }
  return {
    key,
    kind: 'scalar',
    value: value === undefined ? null : value,
  };
}

function nodeProperties(node: FlowNode, allNodes: Map<string, FlowNode>): PresenceProperty[] {
  const properties: PresenceProperty[] = [];
  for (const key of [...Object.keys(node)].sort()) {
    if (IGNORE_PRESENCE_KEYS.has(key) || key === 'id' || key === 'z') {
      continue;
    }
    if (key === 'wires') {
      const structured = describeWiresStructured(node, allNodes);
      properties.push({
        key: 'wires',
        kind: 'scalar',
        value: structured.length > 0 ? structured : (node.wires ?? null),
      });
      continue;
    }
    properties.push(toPresenceProperty(node, key, node[key]));
  }
  return properties;
}

/** One output port with resolved target nodes (id + display name). */
export interface WirePortDescription {
  port: number;
  to: { id: string; name: string }[];
}

/**
 * Describe wires as `[{port, to:[{id,name}]}]` so diffs keep structure
 * (not a flat name-only string).
 */
export function describeWiresStructured(
  node: FlowNode,
  allNodes: Map<string, FlowNode>
): WirePortDescription[] {
  const wires = node.wires;
  if (!Array.isArray(wires) || wires.length === 0) {
    return [];
  }
  const result: WirePortDescription[] = [];
  wires.forEach((port, portIndex) => {
    if (!Array.isArray(port)) {
      return;
    }
    const to: { id: string; name: string }[] = [];
    for (const targetId of port) {
      if (typeof targetId !== 'string' || !targetId) {
        continue;
      }
      const target = allNodes.get(targetId);
      to.push({
        id: targetId,
        name: target ? (nodeName(target) ?? target.type) : targetId,
      });
    }
    result.push({ port: portIndex, to });
  });
  return result;
}

const KEY_FIELD_TEXT_KEYS = new Set(['func', 'template', 'code', 'text']);

function buildKeyFields(node: FlowNode, allNodes: Map<string, FlowNode>): PresenceProperty[] {
  const fields: PresenceProperty[] = [];
  const name = nodeName(node);
  if (name) {
    fields.push({ key: 'name', kind: 'scalar', value: name });
  }
  const wireStruct = describeWiresStructured(node, allNodes);
  if (wireStruct.length > 0) {
    fields.push({ key: 'wires', kind: 'scalar', value: wireStruct });
  }
  for (const key of KEY_FIELD_TEXT_KEYS) {
    if (!(key in node)) {
      continue;
    }
    const text = asText(node[key]);
    if (text === null || text.length === 0) {
      continue;
    }
    fields.push(toPresenceProperty(node, key, text));
  }
  return fields;
}

function buildModifiedSummary(node: FlowNode, flowLabel: string, changeCount: number): string {
  const type = nodeTypeText(node.type);
  const name = nodeName(node);
  const named = name ? ` "${name}"` : '';
  const where = flowLabel ? ` in "${flowLabel}"` : '';
  const fields = changeCount === 1 ? '1 field' : `${changeCount} fields`;
  return `Changes ${type} node${named}${where} (${fields})`;
}

function buildPresenceSummary(
  node: FlowNode,
  kind: 'added' | 'removed',
  flowLabel: string
): string {
  const type = nodeTypeText(node.type);
  const name = nodeName(node);
  const verb = kind === 'added' ? 'Adds' : 'Removes';
  const prep = kind === 'added' ? 'to' : 'from';
  const namePart = name ? ` ${JSON.stringify(name)}` : '';
  const flowPart = flowLabel ? ` ${prep} flow ${JSON.stringify(flowLabel)}` : '';
  let sentence = `${verb} ${type} node${namePart}${flowPart}`;

  if (kind === 'added' && type === 'template') {
    const field = typeof node.field === 'string' && node.field ? node.field : '';
    if (field) {
      sentence += `, output to msg.${field}`;
    }
  }
  return sentence;
}

function toPresenceNode(
  node: FlowNode,
  kind: 'added' | 'removed',
  flowLabel: string,
  allNodes: Map<string, FlowNode>
): PresenceNodeDiff {
  const entry: PresenceNodeDiff = {
    id: node.id,
    type: node.type,
    summary: buildPresenceSummary(node, kind, flowLabel),
    keyFields: buildKeyFields(node, allNodes),
    properties: nodeProperties(node, allNodes),
  };
  const name = nodeName(node);
  if (name !== undefined) {
    entry.name = name;
  }
  return entry;
}

function compareNodes(before: FlowNode, after: FlowNode): PropertyChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: PropertyChange[] = [];
  for (const key of [...keys].sort()) {
    if (IGNORE_COMPARE_KEYS.has(key) || key === 'id' || key === 'z') {
      continue;
    }
    const left = before[key];
    const right = after[key];
    if (valuesEqual(left, right)) {
      continue;
    }
    const leftText = asText(left);
    const rightText = asText(right);
    if (TEXT_PROPERTY_KEYS.has(key) && (leftText !== null || rightText !== null)) {
      const beforeText = leftText ?? '';
      const afterText = rightText ?? '';
      changes.push({
        key,
        kind: 'text',
        before: beforeText,
        after: afterText,
        lines: diffLines(beforeText, afterText),
      });
      continue;
    }
    changes.push({
      key,
      kind: 'scalar',
      before: left === undefined ? null : left,
      after: right === undefined ? null : right,
    });
  }
  return changes;
}

function compareTabMeta(before: Partial<FlowTab>, after: Partial<FlowTab>): string[] {
  const keys = ['label', 'disabled', 'info', 'env'] as const;
  const out: string[] = [];
  for (const key of keys) {
    const fallback = key === 'disabled' ? false : key === 'env' ? [] : '';
    if (!valuesEqual(before[key] ?? fallback, after[key] ?? fallback)) {
      out.push(key);
    }
  }
  return out;
}

/**
 * True when a pending proposal would delete more than half of the before nodes.
 * Used for the typed DELETE confirmation before Approve & deploy.
 */
export function isLargeDelete(
  summary:
    | {
        beforeNodeCount?: number;
        removed?: number;
      }
    | null
    | undefined
): boolean {
  if (!summary) return false;
  const before = Number(summary.beforeNodeCount) || 0;
  const removed = Number(summary.removed) || 0;
  if (before <= 0 || removed <= 0) return false;
  return removed / before > 0.5;
}

/**
 * Pure compare of a proposed flow tab against a before (base or live) tab.
 */
function flowLabelOf(flow: Partial<FlowTab>): string {
  return typeof flow.label === 'string' && flow.label.trim() ? flow.label.trim() : '';
}

/** Resolve merge paths such as env["API_URL"].value without evaluating code. */
export function conflictFieldValue(object: unknown, path: string): unknown {
  const parts = path.match(/\["(?:[^"\\]|\\.)*"\]|[^.[\]]+/g) ?? [];
  let value = object;
  for (const part of parts) {
    if (part.startsWith('[')) {
      const name: unknown = JSON.parse(part.slice(1, -1));
      value = Array.isArray(value)
        ? (value as unknown[]).find(
            entry =>
              !!entry &&
              typeof entry === 'object' &&
              (entry as Record<string, unknown>).name === name
          )
        : undefined;
    } else {
      value =
        value && typeof value === 'object' && Object.hasOwn(value, part)
          ? (value as Record<string, unknown>)[part]
          : undefined;
    }
  }
  return value;
}

export function buildDiffSections(
  afterFlow: Partial<FlowTab>,
  beforeFlow: Partial<FlowTab>
): DiffSections {
  const beforeNodes = collectNodes(beforeFlow);
  const afterNodes = collectNodes(afterFlow);
  const afterLabel = flowLabelOf(afterFlow) || flowLabelOf(beforeFlow);
  const beforeLabel = flowLabelOf(beforeFlow) || flowLabelOf(afterFlow);

  const added: PresenceNodeDiff[] = [];
  const removed: PresenceNodeDiff[] = [];
  const modified: ModifiedNodeDiff[] = [];

  // Preserve flow/wiring order (nodes array order) — do not sort added by id.
  for (const node of afterFlow.nodes ?? []) {
    if (!beforeNodes.has(node.id)) {
      added.push(toPresenceNode(node, 'added', afterLabel, afterNodes));
    }
  }
  for (const node of afterFlow.configs ?? []) {
    if (!beforeNodes.has(node.id)) {
      added.push(toPresenceNode(node, 'added', afterLabel, afterNodes));
    }
  }
  for (const node of beforeFlow.nodes ?? []) {
    if (!afterNodes.has(node.id)) {
      removed.push(toPresenceNode(node, 'removed', beforeLabel, beforeNodes));
    }
  }
  for (const node of beforeFlow.configs ?? []) {
    if (!afterNodes.has(node.id)) {
      removed.push(toPresenceNode(node, 'removed', beforeLabel, beforeNodes));
    }
  }
  for (const [id, after] of afterNodes) {
    const before = beforeNodes.get(id);
    if (!before) {
      continue;
    }
    const changes = compareNodes(before, after);
    if (changes.length > 0) {
      const entry: ModifiedNodeDiff = {
        id,
        type: after.type || before.type,
        summary: buildModifiedSummary(after, afterLabel || beforeLabel, changes.length),
        changes,
      };
      const name = nodeName(after) ?? nodeName(before);
      if (name !== undefined) {
        entry.name = name;
      }
      modified.push(entry);
    }
  }

  // Modified can stay id-sorted for stable UI; added/removed keep patch order.
  modified.sort((a, b) => a.id.localeCompare(b.id));

  return {
    summary: {
      added: added.length,
      removed: removed.length,
      modified: modified.length,
      tabChanges: compareTabMeta(beforeFlow, afterFlow),
      beforeNodeCount: beforeNodes.size,
      afterNodeCount: afterNodes.size,
    },
    tabProperties: compareTabMeta(beforeFlow, afterFlow).map(key => ({
      key,
      kind: 'scalar',
      before: beforeFlow[key],
      after: afterFlow[key],
    })),
    added,
    removed,
    modified,
  };
}

/**
 * Pure compare of a proposal payload against a before-flow snapshot.
 * `before.rev` is used as `currentRev` unless `options.currentRev` is set.
 */
export function buildProposalDiff(
  proposal: Proposal,
  before: { rev: string; flow: Partial<FlowTab> },
  options: {
    currentRev?: string;
    compareAgainst?: 'base' | 'current';
    baseSnapshotMissing?: boolean;
    /** Informational revision difference (default: open && expectedRev !== currentRev). */
    baseRevChanged?: boolean;
    vsCurrent?: DiffSections;
  } = {}
): ProposalDiffResult {
  const sections = buildDiffSections(proposal.payload.flow, before.flow);
  const currentRev = options.currentRev ?? before.rev;
  const expectedRev = proposal.expectedRev;
  const baseRevChanged =
    options.baseRevChanged ?? (isOpenProposalStatus(proposal.status) && expectedRev !== currentRev);

  const result: ProposalDiffResult = {
    proposalId: proposal.id,
    flowId: proposal.payload.flowId,
    expectedRev,
    baseRev: expectedRev,
    currentRev,
    baseRevChanged,
    compareAgainst: options.compareAgainst ?? 'current',
    ...sections,
  };
  if (proposal.warnings && proposal.warnings.length > 0) {
    result.warnings = proposal.warnings.map(w => ({ ...w }));
  }
  if (options.baseSnapshotMissing) {
    result.baseSnapshotMissing = true;
  }
  if (options.vsCurrent) {
    result.vsCurrent = options.vsCurrent;
  }
  return result;
}

/**
 * Diff a proposal against its stored baseFlow snapshot when present.
 * Pending + stale also attaches `vsCurrent` (proposal vs live flow).
 * Approved/rejected/failed never set `baseRevChanged` (no "approve would fail").
 */
export async function computeProposalDiff(
  proposal: Proposal,
  adapter: FlowAdapter,
  rawProposal: Proposal = proposal
): Promise<ProposalDiffResult> {
  const flowId = proposal.payload.flowId;
  const emptyTab: Partial<FlowTab> = { id: flowId, type: 'tab', nodes: [], configs: [] };

  let liveRev = proposal.expectedRev;
  let liveFlow: Partial<FlowTab> = emptyTab;
  try {
    const snapshot = await adapter.getFlow(flowId);
    liveRev = snapshot.rev;
    liveFlow = snapshot.flow;
  } catch (error) {
    if (!(error instanceof FlowNotFoundError)) {
      throw error;
    }
    try {
      const flows = await adapter.getFlows();
      liveRev = flows.rev;
    } catch {
      // keep expectedRev
    }
  }

  const pending = isOpenProposalStatus(proposal.status);
  const baseRevChanged = pending && proposal.expectedRev !== liveRev;
  const storedBase = proposal.baseFlow;

  if (pending) {
    const raw = rawFlowAdapter(adapter);
    const live = await raw.getFlows();
    const rebase = rebaseProposal(rawProposal, live);
    const ai = raw !== adapter;
    const view = ai ? redactProposalForAi(rawProposal) : rawProposal;
    const rawTab = nestedLiveTab(live.flows, flowId, rawProposal.baseFlow) ?? emptyTab;
    const currentTab = ai ? redactFlowData(rawTab).value : rawTab;
    const result = buildProposalDiff(
      view,
      { rev: proposal.expectedRev, flow: view.baseFlow ?? currentTab },
      {
        currentRev: live.rev,
        compareAgainst: view.baseFlow ? 'base' : 'current',
        baseSnapshotMissing: view.baseFlow === undefined,
        baseRevChanged: proposal.expectedRev !== live.rev,
      }
    );
    result.rebase = {
      rev: rebase.rev,
      state: rebase.state,
      conflicts: ai ? redactConflictLabels(rebase.conflicts) : rebase.conflicts,
      ...(rebase.mergedHash ? { mergedHash: rebase.mergedHash } : {}),
    };
    const target = (tab: Partial<FlowTab> | undefined, nodeId: string | undefined) =>
      nodeId === flowId
        ? tab
        : [...(tab?.nodes ?? []), ...(tab?.configs ?? [])].find(n => n.id === nodeId);
    result.conflictValues = rebase.conflicts.map(c => ({
      nodeId: c.nodeId ?? '',
      fields: (c.fields?.length ? c.fields : ['']).map(field => ({
        field,
        base: field
          ? conflictFieldValue(target(view.baseFlow, c.nodeId), field)
          : target(view.baseFlow, c.nodeId),
        live: field
          ? conflictFieldValue(target(currentTab, c.nodeId), field)
          : target(currentTab, c.nodeId),
        proposed: field
          ? conflictFieldValue(target(view.payload.flow, c.nodeId), field)
          : target(view.payload.flow, c.nodeId),
      })),
    }));
    const deployTab = rebase.merged
      ? ai
        ? redactFlowData(rebase.merged).value
        : rebase.merged
      : view.payload.flow;
    result.aiOverrideValues = (view.aiConflictOverrides ?? []).map(c => ({
      nodeId: c.nodeId,
      fields: c.fields.map(field => ({
        field,
        live: field
          ? conflictFieldValue(target(currentTab, c.nodeId), field)
          : target(currentTab, c.nodeId),
        proposed: field
          ? conflictFieldValue(target(deployTab, c.nodeId), field)
          : target(deployTab, c.nodeId),
      })),
    }));
    result.liveChanges = buildDiffSections(currentTab, view.baseFlow ?? currentTab);
    if (rebase.state !== 'conflict' && rebase.merged) {
      result.vsCurrent = buildDiffSections(
        ai ? redactFlowData(rebase.merged).value : rebase.merged,
        currentTab
      );
    }
    return result;
  }

  if (storedBase !== undefined) {
    const vsCurrent = baseRevChanged
      ? buildDiffSections(proposal.payload.flow, liveFlow)
      : undefined;
    return buildProposalDiff(
      proposal,
      { rev: proposal.expectedRev, flow: storedBase },
      {
        currentRev: liveRev,
        compareAgainst: 'base',
        baseRevChanged,
        ...(vsCurrent ? { vsCurrent } : {}),
      }
    );
  }

  // Legacy proposals: fall back to live comparison.
  return buildProposalDiff(
    proposal,
    { rev: liveRev, flow: liveFlow },
    {
      compareAgainst: 'current',
      baseSnapshotMissing: true,
      baseRevChanged,
    }
  );
}
