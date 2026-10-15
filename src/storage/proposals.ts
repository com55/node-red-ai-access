/**
 * Proposal JSON store under `.ai-access/proposals/`.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FlowTab } from '../runtime/types.js';

import type { AiAccessPaths } from './paths.js';

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export type ProposalType = 'replace_flow';

export interface ProposalCreator {
  kind: 'access-link';
  linkId: string;
  label?: string;
}

export interface ProposalDecisionBy {
  kind: 'admin';
  username?: string;
}

export interface ReplaceFlowPayload {
  flowId: string;
  flow: Partial<FlowTab>;
}

export interface Proposal {
  id: string;
  type: ProposalType;
  status: ProposalStatus;
  expectedRev: string;
  payload: ReplaceFlowPayload;
  createdBy: ProposalCreator;
  createdAt: string;
  updatedAt: string;
  decidedBy?: ProposalDecisionBy;
  reason?: string;
  resultRev?: string;
}

export interface CreateProposalInput {
  type: ProposalType;
  expectedRev: string;
  payload: ReplaceFlowPayload;
  createdBy: ProposalCreator;
}

export class ProposalNotFoundError extends Error {
  readonly code = 'proposal_not_found' as const;
  readonly statusCode = 404;
  constructor(id: string) {
    super(`Proposal '${id}' was not found`);
    this.name = 'ProposalNotFoundError';
  }
}

export class ProposalNotPendingError extends Error {
  readonly code = 'proposal_not_pending' as const;
  readonly statusCode = 409;
  constructor(id: string, status: ProposalStatus) {
    super(`Proposal '${id}' is '${status}', not pending`);
    this.name = 'ProposalNotPendingError';
  }
}

export class ProposalConcurrentApproveError extends Error {
  readonly code = 'proposal_approve_in_progress' as const;
  readonly statusCode = 409;
  constructor(id: string) {
    super(`Proposal '${id}' is already being approved`);
    this.name = 'ProposalConcurrentApproveError';
  }
}

export class ProposalStore {
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(
    private readonly paths: AiAccessPaths,
    options: { now?: () => number; randomId?: () => string } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.randomId = options.randomId ?? (() => randomBytes(12).toString('hex'));
  }

  private fileFor(id: string): string {
    return join(this.paths.proposals, `${id}.json`);
  }

  private writeAtomic(id: string, proposal: Proposal): void {
    const target = this.fileFor(id);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
    renameSync(temp, target);
  }

  create(input: CreateProposalInput): Proposal {
    const at = new Date(this.now()).toISOString();
    const id = `prop-${this.randomId()}`;
    const proposal: Proposal = {
      id,
      type: input.type,
      status: 'pending',
      expectedRev: input.expectedRev,
      payload: input.payload,
      createdBy: input.createdBy,
      createdAt: at,
      updatedAt: at,
    };
    this.writeAtomic(id, proposal);
    return proposal;
  }

  get(id: string): Proposal {
    const path = this.fileFor(id);
    if (!existsSync(path)) {
      throw new ProposalNotFoundError(id);
    }
    return JSON.parse(readFileSync(path, 'utf8')) as Proposal;
  }

  list(filter?: { linkId?: string }): Proposal[] {
    if (!existsSync(this.paths.proposals)) {
      return [];
    }
    const files = readdirSync(this.paths.proposals).filter(name => name.endsWith('.json'));
    const proposals: Proposal[] = [];
    for (const file of files) {
      try {
        const proposal = JSON.parse(
          readFileSync(join(this.paths.proposals, file), 'utf8')
        ) as Proposal;
        if (filter?.linkId && proposal.createdBy.linkId !== filter.linkId) {
          continue;
        }
        proposals.push(proposal);
      } catch {
        // skip corrupt
      }
    }
    return proposals.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * Begin an approve attempt. Throws if another approve is in flight or status
   * is not pending. Caller must call finishApprove / failApprove / releaseLock.
   */
  beginApprove(id: string): Proposal {
    if (this.inFlight.has(id)) {
      throw new ProposalConcurrentApproveError(id);
    }
    const proposal = this.get(id);
    if (proposal.status !== 'pending') {
      throw new ProposalNotPendingError(id, proposal.status);
    }
    this.inFlight.add(id);
    return proposal;
  }

  releaseLock(id: string): void {
    this.inFlight.delete(id);
  }

  markApproved(id: string, decidedBy: ProposalDecisionBy, resultRev: string): Proposal {
    const proposal = this.get(id);
    proposal.status = 'approved';
    proposal.decidedBy = decidedBy;
    proposal.resultRev = resultRev;
    proposal.updatedAt = new Date(this.now()).toISOString();
    this.writeAtomic(id, proposal);
    return proposal;
  }

  markRejected(id: string, decidedBy: ProposalDecisionBy | undefined, reason: string): Proposal {
    const proposal = this.get(id);
    proposal.status = 'rejected';
    if (decidedBy) {
      proposal.decidedBy = decidedBy;
    }
    proposal.reason = reason;
    proposal.updatedAt = new Date(this.now()).toISOString();
    this.writeAtomic(id, proposal);
    return proposal;
  }

  markFailed(id: string, decidedBy: ProposalDecisionBy | undefined, reason: string): Proposal {
    const proposal = this.get(id);
    proposal.status = 'failed';
    if (decidedBy) {
      proposal.decidedBy = decidedBy;
    }
    proposal.reason = reason;
    proposal.updatedAt = new Date(this.now()).toISOString();
    this.writeAtomic(id, proposal);
    return proposal;
  }
}
