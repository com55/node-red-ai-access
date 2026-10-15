/**
 * Pure helpers for merging tab updates into the flat Admin API flows array.
 */

import { FlowNotFoundError } from './errors.js';
import type { FlowNode, FlowTab, FlowsSnapshot } from './types.js';

function asFlowNode(value: unknown, label: string): FlowNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a node object`);
  }
  const node = value as Record<string, unknown>;
  if (typeof node.id !== 'string' || node.id.length === 0) {
    throw new Error(`${label} needs a non-empty string id`);
  }
  if (typeof node.type !== 'string' || node.type.length === 0) {
    throw new Error(`${label} '${node.id}' needs a non-empty string type`);
  }
  return node as FlowNode;
}

/**
 * Replace one tab (or subflow) and its children inside a flat flows array.
 * Other tabs, subflows, and global config nodes are preserved.
 */
export function replaceFlowTabInFlatFlows(
  flows: FlowNode[],
  flowId: string,
  flowData: Partial<FlowTab>
): FlowNode[] {
  const existingTab = flows.find(node => node.id === flowId);
  if (!existingTab || (existingTab.type !== 'tab' && existingTab.type !== 'subflow')) {
    throw new FlowNotFoundError(flowId);
  }

  const tabNode: FlowNode = {
    ...existingTab,
    id: flowId,
    type: existingTab.type,
  };
  delete tabNode.nodes;
  delete tabNode.configs;
  delete tabNode.subflows;
  if (flowData.label !== undefined) tabNode.label = flowData.label;
  if (flowData.disabled !== undefined) tabNode.disabled = flowData.disabled;
  if (flowData.info !== undefined) tabNode.info = flowData.info;
  if (flowData.env !== undefined) tabNode.env = flowData.env;

  const children: FlowNode[] = [];
  for (const [index, node] of (flowData.nodes ?? []).entries()) {
    children.push({ ...asFlowNode(node, `flowData.nodes[${index}]`), z: flowId });
  }
  for (const [index, config] of (flowData.configs ?? []).entries()) {
    children.push({ ...asFlowNode(config, `flowData.configs[${index}]`), z: flowId });
  }

  const kept = flows.filter(node => node.id !== flowId && node.z !== flowId);
  return [...kept, tabNode, ...children];
}

export function assertFlowsSnapshot(value: unknown, what: string): FlowsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${what} to be an object with rev and flows`);
  }
  const data = value as Record<string, unknown>;
  if (typeof data.rev !== 'string' || data.rev.length === 0) {
    throw new Error(`Expected ${what}.rev to be a non-empty string`);
  }
  if (!Array.isArray(data.flows)) {
    throw new Error(`Expected ${what}.flows to be an array`);
  }
  return { rev: data.rev, flows: data.flows as FlowNode[] };
}

export function normalizeFlowTab(flowId: string, value: unknown): FlowTab {
  if (Array.isArray(value)) {
    const tab = value.find(
      entry =>
        entry &&
        typeof entry === 'object' &&
        (entry as FlowNode).id === flowId &&
        ((entry as FlowNode).type === 'tab' || (entry as FlowNode).type === 'subflow')
    ) as FlowNode | undefined;
    if (!tab) {
      throw new FlowNotFoundError(flowId);
    }
    const nodes = value.filter(
      entry =>
        entry &&
        typeof entry === 'object' &&
        (entry as FlowNode).id !== flowId &&
        (entry as FlowNode).z === flowId
    ) as FlowNode[];
    const nested: FlowTab = {
      id: flowId,
      type: tab.type,
      nodes,
    };
    if (typeof tab.label === 'string') nested.label = tab.label;
    if (typeof tab.disabled === 'boolean') nested.disabled = tab.disabled;
    if (typeof tab.info === 'string') nested.info = tab.info;
    return nested;
  }

  if (!value || typeof value !== 'object') {
    throw new FlowNotFoundError(flowId);
  }

  const flow = value as FlowTab;
  const id = typeof flow.id === 'string' && flow.id.length > 0 ? flow.id : flowId;
  // Node-RED's getFlow often omits `type` on tabs; always expose it for AI clients.
  const type = typeof flow.type === 'string' && flow.type.length > 0 ? flow.type : 'tab';
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const normalized: FlowTab = {
    ...flow,
    id,
    type,
    nodes,
  };
  if (Array.isArray(flow.configs)) {
    normalized.configs = flow.configs;
  }
  return normalized;
}
