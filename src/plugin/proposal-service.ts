/**
 * Approve / reject proposals through the FlowAdapter with audit logging.
 */

import { FlowRevisionConflictError } from '../runtime/errors.js';
import type { DeploymentType, FlowAdapter } from '../runtime/types.js';
import type { AuditLog } from '../storage/audit-log.js';
import {
  ProposalConflictError,
  ProposalConcurrentApproveError,
  ProposalNotPendingError,
  isOpenProposalStatus,
  type Proposal,
  type ProposalDecisionBy,
  type ProposalStore,
} from '../storage/proposals.js';

import { presentProposal, resolveFlowLabel } from './proposal-present.js';
import { hashFlowTab, nestedLiveTab } from './proposal-rebase.js';
import {
  expireByTtl,
  isPastTtl,
  rebaseInfoFrom,
  syncOneProposal,
  syncOpenProposals,
} from './proposal-sync.js';
import { rawFlowAdapter } from './secret-redaction.js';

function auditProposalMeta(proposal: Proposal): {
  proposalId: string;
  title: string;
  displayName: string;
  flowId: string;
  flowLabel?: string;
} {
  const presented = presentProposal(proposal);
  const flowLabel = resolveFlowLabel(proposal) || undefined;
  return {
    proposalId: proposal.id,
    title: presented.title,
    displayName: presented.displayName,
    flowId: proposal.payload.flowId,
    ...(flowLabel ? { flowLabel } : {}),
  };
}

/** Approve needs the reviewer to confirm the rebased (merged) result. */
export class ProposalRebaseAckRequiredError extends Error {
  readonly code = 'rebase_ack_required' as const;
  readonly statusCode = 409;
  readonly mergedHash: string;
  readonly rebaseState: 'clean' | 'merged';
  constructor(id: string, mergedHash: string, rebaseState: 'clean' | 'merged') {
    super(
      `Proposal '${id}' was rebased onto newer editor changes since you viewed it. ` +
        'Review the updated diff, then approve again with the new mergedHash.'
    );
    this.name = 'ProposalRebaseAckRequiredError';
    this.mergedHash = mergedHash;
    this.rebaseState = rebaseState;
  }
}

/** Live flows kept moving between rebase and deploy (retries exhausted). */
export class ProposalRebaseRaceError extends Error {
  readonly code = 'rebase_race' as const;
  readonly statusCode = 409;
  constructor(id: string) {
    super(
      `Proposal '${id}' could not be applied because the flows kept changing during approve. ` +
        'It is still pending — try again.'
    );
    this.name = 'ProposalRebaseRaceError';
  }
}

/** The caller deadline elapsed; the runtime outcome remains unknown. */
export class ProposalDeployTimeoutError extends Error {
  readonly code = 'deploy_timeout' as const;
  readonly statusCode = 504;
  constructor() {
    super(
      'Deployment timed out; the deploy outcome is unknown. The proposal remains pending with deployPending set. Approvals wait until the runtime settles or the deploy hard cap is reached. Check the live flow before approving again.'
    );
    this.name = 'ProposalDeployTimeoutError';
  }
}

/** The approval never left the queue before its waiting deadline. */
export class ProposalApproveQueueTimeoutError extends Error {
  readonly code = 'approve_queue_timeout' as const;
  readonly statusCode = 504;
  constructor() {
    super(
      'Approval timed out waiting in the queue. No deployment was started for this request. Check the live flow and retry.'
    );
    this.name = 'ProposalApproveQueueTimeoutError';
  }
}

class DeployHardCapError extends Error {}

export interface ProposalServiceOptions {
  /** Maximum time to await updateFlow (default 60 seconds). Does not cancel the runtime operation. */
  deployTimeoutMs?: number;
  /** Maximum time waiting to start approval (default 60 seconds). */
  approveQueueTimeoutMs?: number;
  /** Release the queue after this much unsettled deployment time (default 5 minutes). */
  deployHardCapMs?: number;
}

const MAX_APPROVE_ATTEMPTS = 3;

function deadlineMs(configured: number | undefined, fallback: number): number {
  return configured !== undefined && Number.isFinite(configured) && configured > 0
    ? configured
    : fallback;
}

// Shared by every service/entry point: adapter revision checks are not atomic
// with deployment, so only one approval may read, merge and deploy at a time.
let approveQueue = Promise.resolve();

export interface ApproveOptions {
  deploymentType?: DeploymentType;
  /**
   * `mergedHash` the reviewer last saw. Required when the rebase merged live
   * changes into the proposal; when supplied it must match the current merge.
   */
  mergedHash?: string;
}

export class ProposalService {
  constructor(
    private readonly proposals: ProposalStore,
    private readonly audit: AuditLog,
    private readonly adapter: FlowAdapter,
    private readonly getDeploymentType: () => DeploymentType,
    private readonly serviceOptions: ProposalServiceOptions = {}
  ) {}

  async approve(
    id: string,
    decidedBy: ProposalDecisionBy,
    options: ApproveOptions = {}
  ): Promise<Proposal> {
    const initial = this.proposals.get(id);
    const waitingForOutcome = initial.deployPending !== undefined;
    if (!isOpenProposalStatus(initial.status)) {
      throw new ProposalNotPendingError(id, initial.status);
    }
    // Check active clicks without locking a proposal that is only queued.
    if (!waitingForOutcome && this.proposals.isApproving(id)) {
      throw new ProposalConcurrentApproveError(id);
    }
    const previous = approveQueue;
    let release!: () => void;
    const slot = new Promise<void>(resolve => {
      release = resolve;
    });
    // An abandoned slot must not let its successors jump past an active deploy.
    approveQueue = previous.then(() => slot);
    return new Promise<Proposal>((resolve, reject) => {
      let ownsLock = false;
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_resolve, rejectWait) => {
        timer = setTimeout(
          () => rejectWait(new ProposalApproveQueueTimeoutError()),
          deadlineMs(this.serviceOptions.approveQueueTimeoutMs, 60_000)
        );
        timer.unref?.();
      });
      const run = async () => {
        try {
          await Promise.race([previous, deadline]);
          clearTimeout(timer);
          const current = this.proposals.get(id);
          if (waitingForOutcome && current.status === 'approved') return current;
          const proposal = this.proposals.beginApprove(id);
          ownsLock = true;
          return await this.approveLocked(proposal, decidedBy, options, reject);
        } finally {
          clearTimeout(timer);
          if (ownsLock) this.proposals.releaseLock(id);
          release();
        }
      };
      // The caller deploy deadline rejects promptly; run holds the queue only
      // until settlement or the hard cap, whichever comes first.
      void run().then(resolve, reject);
    });
  }

  private async approveLocked(
    proposal: Proposal,
    decidedBy: ProposalDecisionBy,
    options: ApproveOptions,
    onTimeout: (error: ProposalDeployTimeoutError) => void
  ): Promise<Proposal> {
    const id = proposal.id;
    let approved: Proposal | undefined;
    const meta = auditProposalMeta(proposal);
    const deploymentType = options.deploymentType ?? this.getDeploymentType();
    // Guard for future proposal types (today only replace_flow exists).
    const proposalType: string = proposal.type;
    if (proposalType !== 'replace_flow') {
      const failed = this.proposals.markFailed(
        id,
        decidedBy,
        `Unsupported proposal type '${proposalType}'`
      );
      this.audit.append('proposal.failed', decidedBy, {
        ...meta,
        reason: failed.reason,
      });
      return failed;
    }
    if (isPastTtl(proposal)) {
      this.proposals.releaseLock(id);
      expireByTtl(this.proposals, { flowId: proposal.payload.flowId });
      throw new ProposalNotPendingError(id, this.proposals.get(id).status);
    }

    const raw = rawFlowAdapter(this.adapter);
    const markAlreadyApplied = (current: Proposal, rev: string): Proposal => {
      const applied = this.proposals.markApproved(id, decidedBy, rev);
      this.audit.append('proposal.approved', decidedBy, {
        ...meta,
        resultRev: rev,
        liveRev: rev,
        baseRev: current.expectedRev,
        alreadyApplied: true,
      });
      return applied;
    };
    for (let attempt = 0; attempt < MAX_APPROVE_ATTEMPTS; attempt++) {
      // Re-check atomically against the live flows right before deploying.
      const live = await raw.getFlows();
      const current = this.proposals.get(id);
      const liveTab = nestedLiveTab(live.flows, current.payload.flowId, current.payload.flow);
      const liveHash = liveTab && hashFlowTab(liveTab);
      if (
        liveHash &&
        (liveHash === current.deployPending?.mergedHash ||
          liveHash === hashFlowTab(current.payload.flow))
      ) {
        approved = markAlreadyApplied(current, live.rev);
        break;
      }
      const { result } = syncOneProposal(this.proposals, current, live, { duringApprove: true });
      if (result.state === 'conflict' || !result.merged || !result.mergedHash) {
        this.audit.append('proposal.conflict', decidedBy, {
          ...meta,
          liveRev: live.rev,
          conflictCount: result.conflicts.length,
        });
        throw new ProposalConflictError(id, rebaseInfoFrom(result).conflicts);
      }
      if (liveHash === result.mergedHash) {
        approved = markAlreadyApplied(current, live.rev);
        break;
      }
      const needsAck = result.state === 'merged' || options.mergedHash !== undefined;
      if (needsAck && options.mergedHash !== result.mergedHash) {
        throw new ProposalRebaseAckRequiredError(id, result.mergedHash, result.state);
      }
      const merged = result.merged;
      const mergedHash = result.mergedHash;
      let timedOut = false;
      try {
        const applied = await this.withDeployDeadline(
          () =>
            raw.updateFlow({
              flowId: current.payload.flowId,
              flow: merged,
              expectedRev: live.rev,
              deploymentType,
            }),
          () => {
            timedOut = true;
            const error = new ProposalDeployTimeoutError();
            this.proposals.recordDeployPending(id, {
              mergedHash,
              reason: 'Deploy outcome unknown: the runtime has not settled. Approvals are waiting.',
            });
            this.audit.append('proposal.deploy_timeout', decidedBy, { ...meta, code: error.code });
            onTimeout(error);
          },
          () => {
            this.proposals.recordDeployPending(id, {
              mergedHash,
              queueReleased: true,
              reason:
                'Deploy outcome unknown: the runtime did not settle before the hard cap. The approval queue was released. Check the live flow before approving again.',
            });
            onTimeout(new ProposalDeployTimeoutError());
          }
        );
        approved = this.proposals.markApproved(id, decidedBy, applied.rev);
        this.audit.append('proposal.approved', decidedBy, {
          ...meta,
          resultRev: applied.rev,
          flowId: current.payload.flowId,
          baseRev: current.expectedRev,
          liveRev: live.rev,
          rebaseState: result.state,
        });
        break;
      } catch (error) {
        if (approved) throw error; // an audit error must not undo a recorded success
        if (error instanceof DeployHardCapError) throw error; // retain unknown outcome
        if (timedOut) {
          this.proposals.recordDeployPending(id, undefined);
          throw error; // caller already received 504; leave the proposal pending
        }
        if (error instanceof FlowRevisionConflictError) {
          continue; // flows moved between read and deploy — rebase again
        }
        const message = error instanceof Error ? error.message : String(error);
        const failed = this.proposals.markFailed(id, decidedBy, message);
        this.audit.append('proposal.failed', decidedBy, {
          ...meta,
          reason: message,
        });
        return failed;
      }
    }
    if (!approved) {
      throw new ProposalRebaseRaceError(id);
    }
    // Other open proposals on this flow are rebased onto the new rev (not superseded).
    try {
      await syncOpenProposals(this.proposals, this.adapter, {
        flowId: approved.payload.flowId,
      });
    } catch {
      // best-effort
    }
    return approved;
  }

  private async withDeployDeadline<T>(
    deploy: () => Promise<T>,
    onTimeout: () => void,
    onHardCap: () => void
  ): Promise<T> {
    const timer = setTimeout(onTimeout, deadlineMs(this.serviceOptions.deployTimeoutMs, 60_000));
    timer.unref?.();
    let capTimer: ReturnType<typeof setTimeout>;
    const cap = new Promise<never>((_resolve, reject) => {
      capTimer = setTimeout(
        () => {
          try {
            onHardCap();
          } finally {
            reject(new DeployHardCapError());
          }
        },
        deadlineMs(this.serviceOptions.deployHardCapMs, 300_000)
      );
      capTimer.unref?.();
    });
    try {
      // Race consumes late rejections too. After the cap no detached deploy
      // bookkeeping may overwrite a newer approval, rejection or withdrawal.
      return await Promise.race([deploy(), cap]);
    } finally {
      clearTimeout(timer);
      clearTimeout(capTimer!);
    }
  }

  reject(id: string, decidedBy: ProposalDecisionBy, reason: string): Proposal {
    const proposal = this.proposals.get(id);
    if (!isOpenProposalStatus(proposal.status)) {
      throw new ProposalNotPendingError(id, proposal.status);
    }
    const meta = auditProposalMeta(proposal);
    const rejected = this.proposals.markRejected(
      id,
      decidedBy,
      reason.trim() || 'Rejected by admin'
    );
    this.audit.append('proposal.rejected', decidedBy, {
      ...meta,
      reason: rejected.reason,
    });
    return rejected;
  }
}
