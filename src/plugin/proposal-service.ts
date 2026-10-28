/**
 * Approve / reject proposals through the FlowAdapter with audit logging.
 */

import { FlowRevisionConflictError } from '../runtime/errors.js';
import type { DeploymentType, FlowAdapter } from '../runtime/types.js';
import type { AuditLog } from '../storage/audit-log.js';
import {
  ProposalConflictError,
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

/** The caller deadline elapsed; deployment still holds the approval queue. */
export class ProposalDeployTimeoutError extends Error {
  readonly code = 'deploy_timeout' as const;
  readonly statusCode = 504;
  constructor() {
    super(
      'Deployment timed out; the deploy outcome is unknown. The proposal remains pending with deployPending set, and approvals wait until the runtime settles. A late success marks it approved; a late failure keeps it pending for retry.'
    );
    this.name = 'ProposalDeployTimeoutError';
  }
}

export interface ProposalServiceOptions {
  /** Maximum time to await updateFlow (default 60 seconds). Does not cancel the runtime operation. */
  deployTimeoutMs?: number;
}

const MAX_APPROVE_ATTEMPTS = 3;

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
    // Ordinary concurrent clicks still fail immediately. After a timeout, a
    // retry joins the queue and re-reads the outcome when the deploy settles.
    const waitingForOutcome = this.proposals.get(id).deployPending !== undefined;
    if (!waitingForOutcome) this.proposals.beginApprove(id);
    const previous = approveQueue;
    let release!: () => void;
    approveQueue = new Promise<void>(resolve => {
      release = resolve;
    });
    return new Promise<Proposal>((resolve, reject) => {
      let ownsLock = !waitingForOutcome;
      const run = async () => {
        try {
          await previous;
          const current = this.proposals.get(id);
          if (waitingForOutcome) {
            if (current.status === 'approved') return current;
            this.proposals.beginApprove(id);
            ownsLock = true;
          }
          return await this.approveLocked(current, decidedBy, options, reject);
        } finally {
          if (ownsLock) this.proposals.releaseLock(id);
          release();
        }
      };
      // A timeout rejects only the caller's promise. run still owns the queue
      // and proposal lock until updateFlow and its outcome bookkeeping finish.
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

  private async withDeployDeadline<T>(deploy: () => Promise<T>, onTimeout: () => void): Promise<T> {
    const configured = this.serviceOptions.deployTimeoutMs;
    const timeoutMs =
      configured !== undefined && Number.isFinite(configured) && configured > 0
        ? configured
        : 60_000;
    const timer = setTimeout(onTimeout, timeoutMs);
    timer.unref?.();
    try {
      return await deploy();
    } finally {
      clearTimeout(timer);
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
