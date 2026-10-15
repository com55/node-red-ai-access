/**
 * Approve / reject proposals through the FlowAdapter with audit logging.
 */

import { FlowRevisionConflictError } from '../runtime/errors.js';
import type { DeploymentType, FlowAdapter } from '../runtime/types.js';
import type { AuditLog } from '../storage/audit-log.js';
import {
  ProposalNotPendingError,
  type Proposal,
  type ProposalDecisionBy,
  type ProposalStore,
} from '../storage/proposals.js';

import { presentProposal } from './proposal-present.js';

const REV_CONFLICT_RESUBMIT =
  'Flow revision conflict: the expectedRev is stale. Ask the AI to re-read flows and resubmit a new proposal.';

function auditProposalMeta(proposal: Proposal): {
  proposalId: string;
  title: string;
  displayName: string;
} {
  const presented = presentProposal(proposal);
  return {
    proposalId: proposal.id,
    title: presented.title,
    displayName: presented.displayName,
  };
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
    options: { deploymentType?: DeploymentType } = {}
  ): Promise<Proposal> {
    const proposal = this.proposals.beginApprove(id);
    const meta = auditProposalMeta(proposal);
    const deploymentType = options.deploymentType ?? this.getDeploymentType();
    try {
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

      try {
        const result = await this.adapter.updateFlow({
          flowId: proposal.payload.flowId,
          flow: proposal.payload.flow,
          expectedRev: proposal.expectedRev,
          deploymentType,
        });
        const approved = this.proposals.markApproved(id, decidedBy, result.rev);
        this.audit.append('proposal.approved', decidedBy, {
          ...meta,
          resultRev: result.rev,
          flowId: proposal.payload.flowId,
        });
        return approved;
      } catch (error) {
        if (error instanceof FlowRevisionConflictError) {
          const rejected = this.proposals.markRejected(id, decidedBy, REV_CONFLICT_RESUBMIT);
          this.audit.append('proposal.rejected', decidedBy, {
            ...meta,
            reason: rejected.reason,
            code: error.code,
            expectedRev: error.expectedRev,
            currentRev: error.currentRev,
          });
          return rejected;
        }
        const message = error instanceof Error ? error.message : String(error);
        const failed = this.proposals.markFailed(id, decidedBy, message);
        this.audit.append('proposal.failed', decidedBy, {
          ...meta,
          reason: message,
        });
        return failed;
      }
    } finally {
      this.proposals.releaseLock(id);
    }
  }

  reject(id: string, decidedBy: ProposalDecisionBy, reason: string): Proposal {
    const proposal = this.proposals.get(id);
    if (proposal.status !== 'pending') {
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
