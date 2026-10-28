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
    private readonly getDeploymentType: () => DeploymentType
  ) {}

  async approve(
    id: string,
    decidedBy: ProposalDecisionBy,
    options: ApproveOptions = {}
  ): Promise<Proposal> {
    // Keep the per-proposal guard immediate, including while queued globally.
    const proposal = this.proposals.beginApprove(id);
    const previous = approveQueue;
    let release!: () => void;
    approveQueue = new Promise<void>(resolve => {
      release = resolve;
    });
    try {
      await previous;
      return await this.approveLocked(proposal, decidedBy, options);
    } finally {
      release();
    }
  }

  private async approveLocked(
    proposal: Proposal,
    decidedBy: ProposalDecisionBy,
    options: ApproveOptions
  ): Promise<Proposal> {
    const id = proposal.id;
    let approved: Proposal | undefined;
    try {
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
      for (let attempt = 0; attempt < MAX_APPROVE_ATTEMPTS; attempt++) {
        // Re-check atomically against the live flows right before deploying.
        const live = await raw.getFlows();
        const current = this.proposals.get(id);
        const { result } = syncOneProposal(this.proposals, current, live, { duringApprove: true });
        if (result.state === 'conflict' || !result.merged || !result.mergedHash) {
          this.audit.append('proposal.conflict', decidedBy, {
            ...meta,
            liveRev: live.rev,
            conflictCount: result.conflicts.length,
          });
          throw new ProposalConflictError(id, rebaseInfoFrom(result).conflicts);
        }
        const needsAck = result.state === 'merged' || options.mergedHash !== undefined;
        if (needsAck && options.mergedHash !== result.mergedHash) {
          throw new ProposalRebaseAckRequiredError(id, result.mergedHash, result.state);
        }
        try {
          const applied = await raw.updateFlow({
            flowId: current.payload.flowId,
            flow: result.merged,
            expectedRev: live.rev,
            deploymentType,
          });
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
    } finally {
      this.proposals.releaseLock(id);
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
