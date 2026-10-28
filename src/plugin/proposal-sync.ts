/**
 * Keep open proposals in step with the live flows:
 * - TTL expiry (configurable, default 7 days) closes old open proposals.
 * - Auto-rebase re-checks every open proposal against the live rev and flips
 *   `pending` ↔ `conflict` (never closes a proposal because the rev moved).
 */

import type { FlowAdapter, FlowsSnapshot } from '../runtime/types.js';
import {
  isOpenProposalStatus,
  type Proposal,
  type ProposalRebaseInfo,
  type ProposalStore,
} from '../storage/proposals.js';

import { rebaseFlowTab, type RebaseResult } from './proposal-rebase.js';
import { rawFlowAdapter } from './secret-redaction.js';

export const DEFAULT_PROPOSAL_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

let ttlDaysProvider: () => number = () => DEFAULT_PROPOSAL_TTL_DAYS;
let nowProvider: () => number = () => Date.now();

/** Wire the dashboard setting (days). Values < 1 fall back to the default. */
export function configureProposalTtl(getDays: () => number, now?: () => number): void {
  ttlDaysProvider = getDays;
  nowProvider = now ?? (() => Date.now());
}

export function proposalTtlMs(): number {
  const days = ttlDaysProvider();
  return (Number.isFinite(days) && days >= 1 ? days : DEFAULT_PROPOSAL_TTL_DAYS) * DAY_MS;
}

export function ttlExpiredReason(days: number): string {
  return `Proposal expired: it stayed open longer than the proposal TTL (${days} day${days === 1 ? '' : 's'}). Ask the AI to resubmit if still needed.`;
}

/** True when an open proposal is older than the TTL. */
export function isPastTtl(proposal: Proposal, now = nowProvider()): boolean {
  const created = Date.parse(proposal.createdAt);
  return Number.isFinite(created) && now - created > proposalTtlMs();
}

/** Close open proposals older than the TTL as `expired`. Returns how many closed. */
export function expireByTtl(store: ProposalStore, options: { flowId?: string } = {}): number {
  const now = nowProvider();
  const days = Math.round(proposalTtlMs() / DAY_MS);
  let closed = 0;
  for (const proposal of store.list()) {
    if (!isOpenProposalStatus(proposal.status)) continue;
    if (options.flowId && proposal.payload.flowId !== options.flowId) continue;
    if (store.isApproving(proposal.id)) continue;
    if (!isPastTtl(proposal, now)) continue;
    try {
      store.markClosed(proposal.id, 'expired', ttlExpiredReason(days));
      closed += 1;
    } catch {
      // Race: already decided — skip.
    }
  }
  return closed;
}

/** Pure rebase of one stored proposal against a raw live snapshot. */
export function rebaseProposal(proposal: Proposal, live: FlowsSnapshot): RebaseResult {
  return rebaseFlowTab({
    flowId: proposal.payload.flowId,
    base: proposal.baseFlow,
    proposed: proposal.payload.flow,
    liveFlows: live.flows,
    liveRev: live.rev,
    baseRev: proposal.expectedRev,
  });
}

export function rebaseInfoFrom(result: RebaseResult, at = nowProvider()): ProposalRebaseInfo {
  const info: ProposalRebaseInfo = {
    rev: result.rev,
    state: result.state,
    conflicts: result.conflicts.map(c => ({ ...c, choices: [...c.choices] })),
    liveChangedCount: result.liveChangedIds.length,
    checkedAt: new Date(at).toISOString(),
  };
  if (result.mergedHash) info.mergedHash = result.mergedHash;
  return info;
}

/** Re-check one open proposal and persist the result. */
export function syncOneProposal(
  store: ProposalStore,
  proposal: Proposal,
  live: FlowsSnapshot
): { proposal: Proposal; result: RebaseResult } {
  const result = rebaseProposal(proposal, live);
  const updated = store.recordRebase(proposal.id, rebaseInfoFrom(result));
  return { proposal: updated, result };
}

export interface SyncSummary {
  /** Closed by TTL in this pass. */
  expired: number;
  /** Open proposals now in `conflict`. */
  conflicts: number;
  /** Open proposals checked. */
  checked: number;
}

/**
 * TTL-expire, then rebase every open proposal (optionally one flow) onto the
 * live flows. Always reads the **raw** flows (never a redacted AI view).
 */
export async function syncOpenProposals(
  store: ProposalStore,
  adapter: FlowAdapter | undefined,
  options: { flowId?: string; live?: FlowsSnapshot } = {}
): Promise<SyncSummary> {
  const expired = expireByTtl(store, options.flowId ? { flowId: options.flowId } : {});
  let live = options.live;
  if (!live && adapter) {
    try {
      live = await rawFlowAdapter(adapter).getFlows();
    } catch {
      // Live flows unavailable — keep the last stored rebase state.
    }
  }
  if (!live) return { expired, conflicts: 0, checked: 0 };
  const summary = rebaseOpenProposalsWith(store, live, options);
  return { ...summary, expired: expired + summary.expired };
}

/** Synchronous TTL + rebase pass using an already-read **raw** snapshot. */
export function rebaseOpenProposalsWith(
  store: ProposalStore,
  live: FlowsSnapshot,
  options: { flowId?: string } = {}
): SyncSummary {
  const summary: SyncSummary = { expired: 0, conflicts: 0, checked: 0 };
  for (const proposal of store.list()) {
    if (!isOpenProposalStatus(proposal.status)) continue;
    if (options.flowId && proposal.payload.flowId !== options.flowId) continue;
    if (store.isApproving(proposal.id)) continue;
    try {
      if (isPastTtl(proposal)) {
        summary.expired += expireByTtl(store, { flowId: proposal.payload.flowId });
        continue;
      }
      const { proposal: updated } = syncOneProposal(store, proposal, live);
      summary.checked += 1;
      if (updated.status === 'conflict') summary.conflicts += 1;
    } catch {
      // Corrupt / racing record — skip.
    }
  }
  return summary;
}

/**
 * Debounced background sync for deploy events (`flows:started`).
 * Returns a trigger; calls inside the window collapse into one run.
 */
export function createDebouncedSync(
  run: () => Promise<unknown>,
  delayMs = 500
): { trigger: () => void; flush: () => Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  const exec = async (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await run();
        } catch {
          // best-effort
        }
      } while (again);
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
  };
  return {
    trigger() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void exec();
      }, delayMs);
      timer.unref?.();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await exec();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Raw live flows snapshot, or undefined when the runtime is unavailable. */
export async function tryRawLive(
  adapter: FlowAdapter | undefined
): Promise<FlowsSnapshot | undefined> {
  if (!adapter) return undefined;
  try {
    return await rawFlowAdapter(adapter).getFlows();
  } catch {
    return undefined;
  }
}
