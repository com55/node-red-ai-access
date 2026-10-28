/**
 * Small in-memory history of recent flows snapshots keyed by revision.
 *
 * Lets a proposal submitted against a slightly stale `expectedRev` be based on
 * the exact flows the AI read (then auto-rebased onto the live flows), instead
 * of being rejected. Only revs this process has seen are known; unknown revs
 * still fail with `version_mismatch`.
 */

import { FlowNotFoundError } from './errors.js';
import type { FlowAdapter, FlowNode, FlowSnapshot, FlowTab, FlowsSnapshot } from './types.js';

const DEFAULT_MAX_REVS = 24;

export class RevHistory {
  private readonly byRev = new Map<string, FlowsSnapshot>();
  constructor(private readonly maxRevs = DEFAULT_MAX_REVS) {}

  record(snapshot: FlowsSnapshot): void {
    if (!snapshot || typeof snapshot.rev !== 'string' || !Array.isArray(snapshot.flows)) return;
    if (this.byRev.has(snapshot.rev)) return;
    this.byRev.set(snapshot.rev, {
      rev: snapshot.rev,
      flows: JSON.parse(JSON.stringify(snapshot.flows)) as FlowsSnapshot['flows'],
    });
    while (this.byRev.size > this.maxRevs) {
      const oldest = this.byRev.keys().next().value;
      if (oldest === undefined) break;
      this.byRev.delete(oldest);
    }
  }

  get(rev: string): FlowsSnapshot | undefined {
    const hit = this.byRev.get(rev);
    return hit
      ? { rev: hit.rev, flows: JSON.parse(JSON.stringify(hit.flows)) as FlowsSnapshot['flows'] }
      : undefined;
  }

  has(rev: string): boolean {
    return this.byRev.has(rev);
  }
}

const HISTORY = Symbol.for('ai-access.revHistory');
type WithHistory = FlowAdapter & { [HISTORY]: RevHistory };

/** Wrap an adapter so every flows read records its snapshot by rev. */
export function withRevHistory(inner: FlowAdapter, history = new RevHistory()): FlowAdapter {
  if (HISTORY in inner) return inner;
  const wrapped: WithHistory = {
    kind: inner.kind,
    [HISTORY]: history,
    async getFlows() {
      const snapshot = await inner.getFlows();
      history.record(snapshot);
      return snapshot;
    },
    async getFlow(flowId: string): Promise<FlowSnapshot> {
      const snapshot = await inner.getFlow(flowId);
      if (!history.has(snapshot.rev)) {
        try {
          history.record(await inner.getFlows());
        } catch {
          // history is best-effort
        }
      }
      return snapshot;
    },
    async updateFlow(params) {
      return inner.updateFlow(params);
    },
  };
  return wrapped;
}

/** History attached by {@link withRevHistory}, if any. */
export function revHistoryOf(adapter: FlowAdapter): RevHistory | undefined {
  return HISTORY in adapter ? (adapter as WithHistory)[HISTORY] : undefined;
}

/** Read-only adapter that serves one recorded snapshot (used to rebuild a stale base). */
export function snapshotAdapter(snapshot: FlowsSnapshot, kind: FlowAdapter['kind']): FlowAdapter {
  return {
    kind,
    async getFlows() {
      return { rev: snapshot.rev, flows: JSON.parse(JSON.stringify(snapshot.flows)) };
    },
    async getFlow(flowId: string) {
      const flows = JSON.parse(JSON.stringify(snapshot.flows)) as FlowsSnapshot['flows'];
      const tab = flows.find(n => n.id === flowId && (n.type === 'tab' || n.type === 'subflow'));
      if (!tab) throw new FlowNotFoundError(flowId);
      const nodes: FlowNode[] = [];
      const configs: FlowNode[] = [];
      for (const node of flows) {
        if (node.id === flowId || node.z !== flowId) continue;
        // Config nodes carry no position / wires (same split as GET /flow/:id).
        const isConfig = node.x === undefined && node.y === undefined && node.wires === undefined;
        (isConfig ? configs : nodes).push(node);
      }
      const flow: FlowTab = { id: flowId, type: tab.type, nodes };
      for (const key of ['label', 'disabled', 'info', 'env'] as const) {
        if (tab[key] !== undefined) (flow as Record<string, unknown>)[key] = tab[key];
      }
      if (configs.length > 0) flow.configs = configs;
      return { rev: snapshot.rev, flow };
    },
    async updateFlow() {
      throw new Error('snapshot adapter is read-only');
    },
  };
}
